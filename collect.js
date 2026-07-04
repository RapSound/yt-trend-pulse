/**
 * YT TREND PULSE — collect.js
 * ---------------------------------------------------------------------
 * Ce script est exécuté automatiquement par GitHub Actions (voir
 * .github/workflows/collect.yml), selon un planning (par défaut toutes
 * les 6 heures), INDÉPENDAMMENT de toute connexion de l'utilisateur.
 *
 * Ce qu'il fait à chaque exécution :
 *   1. Pour chaque artiste de la liste blanche, récupère ses uploads
 *      récents via l'API YouTube Data v3 (vraies données).
 *   2. Écrit/actualise chaque vidéo dans Firestore (collection "videos").
 *   3. Ajoute un point d'historique daté du jour dans la sous-collection
 *      "snapshots" (un point par jour civil).
 *   4. Continue de suivre indéfiniment les sons déjà "figés", même s'ils
 *      sortent de la fenêtre des uploads récents d'un artiste.
 *
 * Ce script NE RÉSOUT PAS les chaînes ambiguës tout seul : si un artiste
 * n'a pas encore de chaîne connue dans Firestore (champ meta/channelCache),
 * il est simplement ignoré et un avertissement est affiché dans les logs.
 * → Il faut, une seule fois, ouvrir le site et résoudre le choix de
 *   chaîne via le panneau de notifications (cf. SETUP_GUIDE.md, dernière
 *   étape). Une fois résolu, ce script tourne pour toujours sans aucune
 *   intervention humaine.
 * ---------------------------------------------------------------------
 */

const admin = require('firebase-admin');

// ⚠️ Si tu modifies la liste blanche, fais-le aussi dans index.html
const WHITELIST_ARTISTS = [
  "JUL","Gazo","Aya Nakamura","SCH","Gims","Soprano","Ninho","Tiakola",
  "Werenoi","PLK","SDM","Hamza","Booba","Damso"
];

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const YT_KEY = process.env.YOUTUBE_API_KEY_SERVER;

// -----------------------------------------------------------------------
// INIT FIREBASE ADMIN (utilise le secret GitHub Actions FIREBASE_SERVICE_ACCOUNT)
// -----------------------------------------------------------------------
function initFirestore(){
  if(!process.env.FIREBASE_SERVICE_ACCOUNT){
    throw new Error("Secret FIREBASE_SERVICE_ACCOUNT manquant (à configurer dans GitHub → Settings → Secrets).");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return admin.firestore();
}

// -----------------------------------------------------------------------
// YOUTUBE API
// -----------------------------------------------------------------------
async function ytFetch(endpoint, params){
  const url = new URL(YT_BASE + "/" + endpoint);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  url.searchParams.set("key", YT_KEY);
  const res = await fetch(url.toString());
  const data = await res.json();
  if(!res.ok){
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.message || "erreur inconnue";
    throw new Error(reason);
  }
  return data;
}
function parseISODuration(iso){
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if(!m) return 0;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
}
function computeEngagementScore(likes, views){
  if(!views) return 0;
  const ratio = (likes/views)*100;
  return Math.max(0, Math.min(100, (ratio/10)*100));
}
async function getUploadsPlaylistId(channelId){
  const data = await ytFetch("channels", { part:"contentDetails", id: channelId });
  if(!data.items?.length) throw new Error("Chaîne invalide: " + channelId);
  return data.items[0].contentDetails.relatedPlaylists.uploads;
}
async function getRecentUploadIds(playlistId, max=20){
  const data = await ytFetch("playlistItems", { part:"contentDetails", playlistId, maxResults:String(max) });
  return (data.items||[]).map(it => it.contentDetails.videoId);
}
async function getVideosDetails(ids){
  if(!ids.length) return [];
  const out = [];
  for(let i=0;i<ids.length;i+=50){
    const chunk = ids.slice(i,i+50);
    const data = await ytFetch("videos", { part:"snippet,statistics,contentDetails", id: chunk.join(",") });
    out.push(...(data.items||[]));
  }
  return out;
}

// -----------------------------------------------------------------------
// FIRESTORE WRITE — même schéma de données que le client (index.html)
// -----------------------------------------------------------------------
async function upsertVideoAndSnapshot(db, video, artist){
  const ref = db.collection('videos').doc(video.id);
  const nowIso = new Date().toISOString();
  const dateKey = nowIso.slice(0,10);
  const potential = computeEngagementScore(video.likes, video.views);
  const snap = { t: nowIso, views: video.views, likes: video.likes, commentCount: video.commentCount, potential };

  const doc = await ref.get();
  const prevRecent = doc.exists ? (doc.data().snapshotsRecent || []) : [];
  const recent = [...prevRecent.filter(s => s.t.slice(0,10) !== dateKey), snap]
    .sort((a,b) => a.t.localeCompare(b.t))
    .slice(-10);

  await ref.set({
    title: video.title,
    artist,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    thumbnail: video.thumbnail,
    publishedAt: video.publishedAt,
    duration: video.duration,
    views: video.views,
    likes: video.likes,
    commentCount: video.commentCount,
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
async function run(){
  if(!YT_KEY) throw new Error("Secret YOUTUBE_API_KEY_SERVER manquant (à configurer dans GitHub → Settings → Secrets).");
  const db = initFirestore();

  const cacheDoc = await db.collection('meta').doc('channelCache').get();
  const channelCache = cacheDoc.exists ? cacheDoc.data() : {};

  let totalVideos = 0;
  const skippedArtists = [];

  console.log(`=== YT Trend Pulse — collecte du ${new Date().toISOString()} ===\n`);

  // Passe 1 : uploads récents de chaque artiste whitelisté
  for(const artist of WHITELIST_ARTISTS){
    const channelId = channelCache[artist];
    if(!channelId){
      skippedArtists.push(artist);
      console.log(`⚠️  Pas de chaîne connue pour "${artist}" — ouvre le site et résous le choix de chaîne pour l'activer ici.`);
      continue;
    }
    try{
      console.log(`→ ${artist} (chaîne ${channelId})`);
      const playlistId = await getUploadsPlaylistId(channelId);
      const ids = await getRecentUploadIds(playlistId, 20);
      const details = await getVideosDetails(ids);
      for(const v of details){
        const video = {
          id: v.id,
          title: v.snippet.title,
          channelId,
          channelTitle: v.snippet.channelTitle,
          thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
          publishedAt: v.snippet.publishedAt,
          views: parseInt(v.statistics.viewCount || 0),
          likes: parseInt(v.statistics.likeCount || 0),
          commentCount: parseInt(v.statistics.commentCount || 0),
          duration: parseISODuration(v.contentDetails.duration),
        };
        await upsertVideoAndSnapshot(db, video, artist);
        totalVideos++;
      }
    }catch(e){
      console.log(`✗ Erreur pour ${artist} : ${e.message}`);
    }
  }

  // Passe 2 : continuer de suivre indéfiniment les sons déjà FIGÉS,
  // même s'ils sortent de la fenêtre des uploads récents d'un artiste.
  try{
    const frozenSnap = await db.collection('videos').where('frozen', '==', true).get();
    if(!frozenSnap.empty){
      console.log(`\nMise à jour de ${frozenSnap.size} son(s) figé(s)…`);
      const frozenIds = frozenSnap.docs.map(d => d.id);
      const frozenData = {};
      frozenSnap.docs.forEach(d => frozenData[d.id] = d.data());
      const details = await getVideosDetails(frozenIds);
      for(const v of details){
        const existing = frozenData[v.id];
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
  }catch(e){
    console.log(`✗ Erreur lors de la mise à jour des sons figés : ${e.message}`);
  }

  console.log(`\n=== Terminé. ${totalVideos} vidéo(s) mise(s) à jour. ===`);
  if(skippedArtists.length){
    console.log(`Artistes ignorés (chaîne non résolue) : ${skippedArtists.join(", ")}`);
  }
}

run().catch(e => {
  console.error("Erreur fatale :", e);
  process.exit(1);
});
