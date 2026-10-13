/* ============================================================
   API CANCRI — /api/relances  (tâche automatique / cron)
   Appelée une fois par jour par Vercel Cron.
   Pour chaque commerce avec relances activées :
   trouve les cartes inactives depuis 21 jours (jamais
   relancées, ou relancées il y a longtemps) et envoie une
   notif de relance via le pass Wallet.

   Sécurisée par un secret (CRON_SECRET) pour que personne
   d'autre que Vercel ne puisse la déclencher.
   ============================================================ */

const http2 = require("http2");
const { capacites } = require("./plans");
const { jourParis, FENETRE_JOURS } = require("./anniv");

function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

const JOURS_INACTIF = 21;
const JOURS_AVANT_NOUVELLE_RELANCE = 45; // ne pas re-relancer avant 45j

async function sb(chemin, options) {
  options = options || {};
  const headers = { apikey: SECRET, Authorization: "Bearer " + SECRET, "Content-Type": "application/json" };
  if (options.method === "POST" || options.method === "PATCH") headers["Prefer"] = "return=representation";
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function certDepuisEnv(nom) {
  const b64 = (process.env[nom] || "").trim();
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

async function envoyerPush(jetonCarte) {
  const appareils = await sb("appareils?jeton=eq." + encodeURIComponent(jetonCarte) + "&select=push_token");
  if (!appareils || !appareils.length) return false;
  const cert = certDepuisEnv("PASS_CERT");
  const key = certDepuisEnv("PASS_KEY");
  if (!cert || !key) return false;
  const passphrase = process.env.PASS_KEY_PASSPHRASE || undefined;
  const topic = process.env.PASS_TYPE_ID;
  let ok = false;
  for (const a of appareils) {
    await new Promise((resolve) => {
      let client;
      try { client = http2.connect("https://api.push.apple.com:443", { cert, key, passphrase }); }
      catch (e) { return resolve(); }
      client.on("error", () => { try { client.close(); } catch (x) {} resolve(); });
      const req = client.request({
        ":method": "POST", ":path": "/3/device/" + a.push_token,
        "apns-topic": topic, "apns-push-type": "background", "apns-priority": "5",
      });
      req.on("response", (h) => { if (h[":status"] === 200) ok = true; });
      req.on("end", () => { try { client.close(); } catch (x) {} resolve(); });
      req.on("error", () => { try { client.close(); } catch (x) {} resolve(); });
      req.write(JSON.stringify({})); req.end();
    });
  }
  return ok;
}

/* ============================================================
   RGPD : ménage automatique, une fois par jour
   - cartes sans aucun passage depuis 3 ans (et leur historique)
   - saisies de caisse de plus de 12 mois
   Ne bloque jamais les relances en cas de souci.
   ============================================================ */
async function purgerDonnees() {
  const bilan = { cartes: 0, saisies: 0 };
  try {
    const seuil3ans = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000).toISOString();
    const vieilles = await sb(
      "cartes?or=(dernier_tap.lt." + seuil3ans + ",and(dernier_tap.is.null,cree_le.lt." + seuil3ans + "))" +
      "&select=id,jeton&limit=500"
    );
    for (let i = 0; i < (vieilles || []).length; i += 100) {
      const lot = vieilles.slice(i, i + 100);
      const ids = lot.map((c) => c.id).join(",");
      const jetons = lot.map((c) => '"' + c.jeton + '"').join(",");
      await sb("taps?carte_id=in.(" + ids + ")", { method: "DELETE" });
      await sb("coupons_cartes?carte_id=in.(" + ids + ")", { method: "DELETE" });
      await sb("appareils?jeton=in.(" + encodeURIComponent(jetons) + ")", { method: "DELETE" });
      await sb("cartes?id=in.(" + ids + ")", { method: "DELETE" });
      bilan.cartes += lot.length;
    }
  } catch (e) { console.error("purge cartes:", e.message); }
  try {
    const seuil12mois = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    const r = await sb("caisse_attente?cree_le=lt." + seuil12mois + "&select=id", { method: "DELETE" });
    bilan.saisies = Array.isArray(r) ? r.length : 0;
  } catch (e) { console.error("purge caisse:", e.message); }
  return bilan;
}

/* ============================================================
   ANNIVERSAIRES : le jour J, notif Wallet aux clients des
   commerces qui offrent un cadeau ; 7 jours après, on retire
   le message du dos de la carte.
   ============================================================ */
const DEBUT_MSG_ANNIV = "Joyeux anniversaire";

function mmjj(decalageJours) {
  const j = jourParis(new Date(Date.now() - (decalageJours || 0) * 86400000));
  return j.slice(5);
}
function bissextile(a) { return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0; }
/* le 28 février d'une année non bissextile compte aussi pour les nés le 29 */
function joursCibles(decalage) {
  const d = mmjj(decalage);
  const an = parseInt(jourParis(new Date(Date.now() - (decalage || 0) * 86400000)).slice(0, 4), 10);
  return (d === "02-28" && !bissextile(an)) ? ["02-28", "02-29"] : [d];
}

async function anniversaires() {
  const bilan = { notifs: 0, nettoyes: 0 };
  try {
    const coms = await sb("commerces?cadeau_anniv=not.is.null&select=id,nom,cadeau_anniv");
    const actifs = (coms || []).filter((c) => (c.cadeau_anniv || "").trim());
    if (actifs.length) {
      const ids = actifs.map((c) => c.id).join(",");
      const cartes = await sb("cartes?commerce_id=in.(" + ids + ")&anniversaire=in.(" + joursCibles(0).join(",") + ")" +
        "&select=id,jeton,prenom,commerce_id,message_perso");
      for (const carte of (cartes || [])) {
        if (carte.message_perso && carte.message_perso.indexOf(DEBUT_MSG_ANNIV) === 0) continue; // déjà fait aujourd'hui
        const com = actifs.find((c) => c.id === carte.commerce_id);
        const msg = DEBUT_MSG_ANNIV + (carte.prenom ? " " + carte.prenom : "") + " ! " +
          com.nom + " t'offre : " + com.cadeau_anniv.trim() + ". Valable " + FENETRE_JOURS + " jours, montre ta carte au comptoir.";
        await sb("cartes?id=eq." + carte.id, { method: "PATCH", body: { message_perso: msg.slice(0, 240) } });
        if (await envoyerPush(carte.jeton)) bilan.notifs++;
      }
    }
    /* fin de la semaine d'anniversaire : on retire le message */
    const fin = joursCibles(FENETRE_JOURS);
    const vieux = await sb("cartes?anniversaire=in.(" + fin.join(",") + ")" +
      "&message_perso=like." + encodeURIComponent(DEBUT_MSG_ANNIV) + "*&select=id,jeton");
    for (const c of (vieux || [])) {
      await sb("cartes?id=eq." + c.id, { method: "PATCH", body: { message_perso: null } });
      bilan.nettoyes++;
      try { await envoyerPush(c.jeton); } catch (e) {}
    }
  } catch (e) { console.error("anniversaires:", e.message); }
  return bilan;
}

module.exports = async (req, res) => {
  // sécurité : seul Vercel Cron (avec le secret) peut déclencher
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const fourni = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (fourni !== secret) return res.status(401).json({ ok: false, raison: "non_autorise" });
  }

  try {
    const purge = await purgerDonnees();
    const anniv = await anniversaires();
    const maintenant = Date.now();
    const seuilInactif = new Date(maintenant - JOURS_INACTIF * 24 * 3600 * 1000).toISOString();
    const seuilRelance = new Date(maintenant - JOURS_AVANT_NOUVELLE_RELANCE * 24 * 3600 * 1000).toISOString();

    // commerces avec relances activées
    const tous = await sb("commerces?relances_actives=eq.true&select=*");
    /* seuls les forfaits qui incluent les relances sont traités */
    const commerces = (tous || []).filter((c) => capacites(c).relances === true);
    if (!commerces || !commerces.length) {
      return res.status(200).json({ ok: true, info: "aucun commerce à relancer", total: 0, purge: purge, anniv: anniv });
    }

    let totalRelances = 0;
    const detail = [];

    for (const commerce of commerces) {
      // cartes inactives : dernier_tap < seuil ET (jamais relancée OU relancée il y a longtemps)
      const cartes = await sb(
        "cartes?commerce_id=eq." + commerce.id +
        "&dernier_tap=lt." + encodeURIComponent(seuilInactif) +
        "&select=id,jeton,derniere_relance,tampons,message_perso"
      );
      if (!cartes || !cartes.length) continue;

      const aRelancer = cartes.filter((c) =>
        (!c.derniere_relance || c.derniere_relance < seuilRelance) &&
        !(c.message_perso && c.message_perso.indexOf(DEBUT_MSG_ANNIV) === 0) // on n'écrase pas un message d'anniversaire
      );

      const texteRelance = commerce.message_relance || "Ça fait un moment ! Revenez nous voir ☕";
      for (const carte of aRelancer) {
        // 1. on écrit le message de relance SUR LA CARTE (le pass l'affichera)
        await sb("cartes?id=eq." + carte.id, {
          method: "PATCH",
          body: { message_perso: texteRelance, derniere_relance: new Date().toISOString() },
        });
        // 2. on pousse la mise à jour du pass → notif écran verrouillé
        const envoye = await envoyerPush(carte.jeton);
        if (envoye) totalRelances++;
      }
      detail.push({ commerce: commerce.nom, relances: aRelancer.length });
    }

    return res.status(200).json({ ok: true, total: totalRelances, detail: detail, purge: purge, anniv: anniv });
  } catch (e) {
    console.error("relances error:", e.message || e);
    return res.status(500).json({ ok: false, raison: "erreur_serveur", message: e.message });
  }
};
