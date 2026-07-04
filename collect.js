/**
 * YT TREND PULSE — collect.js (v2)
 * 
 * Ce script est exécuté par GitHub Actions toutes les 6h.
 * Il collecte les données YouTube pour TOUS les artistes
 * stockés dans Firestore (pas de liste blanche codée en dur).
 */

const admin = require('firebase-admin');

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const YT_KEY = process.env.YOUTUBE_API_KEY_SERVER;

// -----------------------------------------------------------------------
// INIT FIREBASE
// -----------------------------------------------------------------------
function initFirestore() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Secret FIREBASE_SERVICE_ACCOUNT manquant.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

// -----------------------------------------------------------------------
// YOUTUBE API
// -----------------------------------------------------------------------
async function ytFetch(endpoint, params) {
  const url = new URL(YT_BASE + "/" + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("key", YT_KEY);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.message || "erreur inconnue";
    throw new Error(reason);
  }
  return data;
}

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

async function getUploadsPlaylistId(channelId) {
  const data = await ytFetch("channels", { part: "contentDetails", id: channelId });
  if (!data.items?.length) throw new Error("Chaîne invalide: " + channelId);
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}

async function getRecentUploadIds(playlistId, max = 20) {
  const data = await ytFetch("playlistItems", { part: "contentDetails", playlistId, maxResults: String(max) });
  return (data.items||[]).map(it => it.contentDetails.videoId);
}

async function getVideosDetails(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await ytFetch("videos", {
      part: "snippet,statistics,contentDetails",
      id: chunk.join(",")
    });
    out.push(...(data.items||[]));
  }
  return out;
}

// -----------------------------------------------------------------------
// FIRESTORE WRITE
// -----------------------------------------------------------------------
async function upsertVideoAndSnapshot(db, video, artist) {
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
  }, { merge: true });

  await ref.collection('snapshots').doc(dateKey).set(snap, { merge: true });
}

// -----------------------------------------------------------------------
// RUN
// -----------------------------------------------------------------------
async function run() {
  if (!YT_KEY) {
    throw new Error("Secret YOUTUBE_API_KEY_SERVER manquant.");
  }

  const db = initFirestore();
  console.log(`=== YT Trend Pulse — collecte du ${new Date().toISOString()} ===\n`);

  // 1. Récupérer la liste des artistes depuis Firestore
  const artistsDoc = await db.collection('meta').doc('artists').get();
  let artists = [];
  if (artistsDoc.exists) {
    artists = artistsDoc.data().list || [];
  }

  if (artists.length === 0) {
    console.log("⚠️ Aucun artiste configuré dans Firestore.");
    console.log("   Va sur le site et ajoute des chaînes dans l'onglet 'Artistes suivis'.");
    return;
  }

  console.log(`📋 ${artists.length} artiste(s) à collecter :`);
  artists.forEach(a => console.log(`   - ${a.name} (${a.channelId})`));
  console.log("");

  let totalVideos = 0;
  const errors = [];

  // 2. Collecte pour chaque artiste
  for (const artist of artists) {
    try {
      console.log(`→ ${artist.name} (${artist.channelId})`);
      const playlistId = await getUploadsPlaylistId(artist.channelId);
      const ids = await getRecentUploadIds(playlistId, 20);
      const details = await getVideosDetails(ids);

      let count = 0;
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
          duration: parseISODuration(v.contentDetails.duration),
        };
        await upsertVideoAndSnapshot(db, video, artist.name);
        count++;
        totalVideos++;
      }
      console.log(`   ✓ ${count} vidéo(s) mises à jour`);
    } catch (e) {
      console.log(`✗ Erreur pour ${artist.name} : ${e.message}`);
      errors.push({ artist: artist.name, error: e.message });
    }
  }

  // 3. Mettre à jour les vidéos figées
  try {
    const frozenSnap = await db.collection('videos').where('frozen', '==', true).get();
    if (!frozenSnap.empty) {
      console.log(`\n🔒 Mise à jour de ${frozenSnap.size} son(s) figé(s)…`);
      const frozenIds = frozenSnap.docs.map(d => d.id);
      const frozenData = {};
      frozenSnap.docs.forEach(d => frozenData[d.id] = d.data());

      const details = await getVideosDetails(frozenIds);
      for (const v of details) {
        const existing = frozenData[v.id];
        if (!existing) continue;
        const video = {
          id: v.id,
          title: v.snippet.title,
          channelId: existing.channelId,
          channelTitle: v.snippet.channelTitle,
          thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
          publishedAt: v.snippet.publishedAt,
          views: parseInt(v.statistics.viewCount || 0),
          likes: parseInt(v.statistics.likeCount || 0),
          commentCount: parseInt(v.statistics.commentCount || 0),
          duration: parseISODuration(v.contentDetails.duration),
        };
        await upsertVideoAndSnapshot(db, video, existing.artist);
        totalVideos++;
      }
    }
  } catch (e) {
    console.log(`✗ Erreur mise à jour des sons figés : ${e.message}`);
    errors.push({ error: "frozen_update", message: e.message });
  }

  console.log(`\n=== Terminé. ${totalVideos} vidéo(s) mises à jour. ===`);
  if (errors.length) {
    console.log("⚠️ Erreurs rencontrées :");
    errors.forEach(e => console.log(`   - ${e.artist || e.error}: ${e.message || e.error}`));
  }
}

run().catch(e => {
  console.error("Erreur fatale :", e);
  process.exit(1);
});
