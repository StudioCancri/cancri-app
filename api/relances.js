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

module.exports = async (req, res) => {
  // sécurité : seul Vercel Cron (avec le secret) peut déclencher
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const fourni = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (fourni !== secret) return res.status(401).json({ ok: false, raison: "non_autorise" });
  }

  try {
    const maintenant = Date.now();
    const seuilInactif = new Date(maintenant - JOURS_INACTIF * 24 * 3600 * 1000).toISOString();
    const seuilRelance = new Date(maintenant - JOURS_AVANT_NOUVELLE_RELANCE * 24 * 3600 * 1000).toISOString();

    // commerces avec relances activées
    const tous = await sb("commerces?relances_actives=eq.true&select=*");
    /* seuls les forfaits qui incluent les relances sont traités */
    const commerces = (tous || []).filter((c) => capacites(c).relances === true);
    if (!commerces || !commerces.length) {
      return res.status(200).json({ ok: true, info: "aucun commerce à relancer", total: 0 });
    }

    let totalRelances = 0;
    const detail = [];

    for (const commerce of commerces) {
      // cartes inactives : dernier_tap < seuil ET (jamais relancée OU relancée il y a longtemps)
      const cartes = await sb(
        "cartes?commerce_id=eq." + commerce.id +
        "&dernier_tap=lt." + encodeURIComponent(seuilInactif) +
        "&select=id,jeton,derniere_relance,tampons"
      );
      if (!cartes || !cartes.length) continue;

      const aRelancer = cartes.filter((c) =>
        !c.derniere_relance || c.derniere_relance < seuilRelance
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

    return res.status(200).json({ ok: true, total: totalRelances, detail: detail });
  } catch (e) {
    console.error("relances error:", e.message || e);
    return res.status(500).json({ ok: false, raison: "erreur_serveur", message: e.message });
  }
};
