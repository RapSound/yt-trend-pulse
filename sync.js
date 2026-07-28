const admin = require('firebase-admin');
const { google } = require('googleapis');

// ============================================================
// RÉCUPÉRATION DES SECRETS GITHUB
// ============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ============================================================
// INITIALISATION FIREBASE
// ============================================================
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'yt-trend-pulse'
});

const db = admin.firestore();
const youtube = google.youtube({
  version: 'v3',
  auth: YOUTUBE_API_KEY
});

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================
function parseISODuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1]||0) * 3600) + (parseInt(m[2]||0) * 60) + parseInt(m[3]||0);
}

function computeEngagementScore(likes, views) {
  if (!views) return 0;
  const ratio = (likes / views) * 100;
  return Math.max(0, Math.min(100, (ratio / 10) * 100));
}

// ============================================================
// APPELS YOUTUBE API
// ============================================================
async function getUploadsPlaylistId(channelId) {
  const res = await youtube.channels.list({
    part: 'contentDetails',
    id: channelId
  });
  if (!res.data.items?.length) throw new Error('Chaîne invalide');
  return res.data.items[0].contentDetails.relatedPlaylists.uploads;
}

async function getRecentUploadIds(playlistId, max = 20) {
  const res = await youtube.playlistItems.list({
    part: 'contentDetails',
    playlistId: playlistId,
    maxResults: max
  });
  return (res.data.items||[]).map(it => it.contentDetails.videoId);
}

async function getVideosDetails(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i+50);
    const res = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: chunk.join(',')
    });
    out.push(...(res.data.items||[]));
  }
  return out;
}

// ============================================================
// FIRESTORE - SAUVEGARDE DES VIDÉOS
// ============================================================
async function fsUpsertVideo(video, artist) {
  const ref = db.collection('videos').doc(video.id);
  const nowIso = new Date().toISOString();
  const dateKey = nowIso.slice(0, 10);
  const potential = computeEngagementScore(video.likes, video.views);
  const snap = {
    t: nowIso,
    views: video.views,
    likes: video.likes,
    commentCount: video.commentCount || 0,
    potential
  };

  const doc = await ref.get();
  const prevRecent = doc.exists ? (doc.data().snapshotsRecent || []) : [];
  const recent = [...prevRecent.filter(s => s.t.slice(0, 10) !== dateKey), snap]
    .sort((a, b) => a.t.localeCompare(b.t))
    .slice(-10);

  const manualCategory = doc.exists ? (doc.data().manualCategory || null) : null;
  const userValidated = doc.exists ? (doc.data().userValidated || false) : false;

  await ref.set({
    title: video.title,
    artist: artist,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    thumbnail: video.thumbnail,
    publishedAt: video.publishedAt,
    duration: video.duration || 0,
    views: video.views,
    likes: video.likes,
    commentCount: video.commentCount || 0,
    snapshotsRecent: recent,
    lastUpdated: nowIso,
    frozen: doc.exists ? (doc.data().frozen || false) : false,
    frozenAt: doc.exists ? (doc.data().frozenAt || null) : null,
    manualCategory: manualCategory,
    userValidated: userValidated || false,
    deleted: doc.exists ? (doc.data().deleted || false) : false,
  }, { merge: true });

  await ref.collection('snapshots').doc(dateKey).set(snap, { merge: true });
}

// ============================================================
// SYNCHRONISATION PRINCIPALE
// ============================================================
async function syncAll() {
  console.log('🚀 Début de la synchronisation...');
  
  const artistsDoc = await db.collection('meta').doc('artists').get();
  const artists = artistsDoc.exists ? (artistsDoc.data().list || []) : [];
  
  if (artists.length === 0) {
    console.log('❌ Aucun artiste suivi.');
    return;
  }

  console.log(`📋 ${artists.length} artiste(s) à synchroniser`);

  let totalVideos = 0;
  for (const artist of artists) {
    console.log(`🎤 Synchronisation de ${artist.name}...`);
    try {
      const playlistId = await getUploadsPlaylistId(artist.channelId);
      const ids = await getRecentUploadIds(playlistId, 20);
      const details = await getVideosDetails(ids);
      for (const v of details) {
        const video = {
          id: v.id,
          title: v.snippet.title,
          channelId: artist.channelId,
          channelTitle: v.snippet.channelTitle,
          thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
          publishedAt: v.snippet.publishedAt,
          views: parseInt(v.statistics.viewCount || 0),
          likes: parseInt(v.statistics.likeCount || 0),
          commentCount: parseInt(v.statistics.commentCount || 0),
          duration: parseISODuration(v.contentDetails.duration)
        };
        await fsUpsertVideo(video, artist.name);
        totalVideos++;
      }
    } catch(e) {
      console.error(`❌ Erreur pour ${artist.name}: ${e.message}`);
    }
  }

  console.log(`✅ Synchronisation terminée : ${totalVideos} vidéo(s) mises à jour.`);
}

// ============================================================
// EXÉCUTION
// ============================================================
syncAll()
  .then(() => {
    console.log('🎉 Sync terminée avec succès');
    process.exit(0);
  })
  .catch((err) => {
    console.error('💥 Erreur fatale:', err);
    process.exit(1);
  });
