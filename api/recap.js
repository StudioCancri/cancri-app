/* ============================================================
   LUNAT — /api/recap  (cron hebdomadaire, lundi matin)
   Pour chaque commerce actif, calcule la semaine écoulée et
   envoie un petit récap par email au(x) propriétaire(s).
   But : rappeler au commerçant que Lunat lui sert (anti-churn).
   Sécurisé par CRON_SECRET.
   ============================================================ */

function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();
const RESEND_KEY = (process.env.RESEND_API_KEY || "").trim();
const EXPEDITEUR = process.env.MAIL_EXPEDITEUR || "Lunat <bonjour@lunat.fr>";

async function sb(chemin) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    headers: { apikey: SECRET, Authorization: "Bearer " + SECRET },
  });
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* email d'un user_id via l'API auth admin */
async function emailDeUser(userId) {
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + userId, {
      headers: { apikey: SECRET, Authorization: "Bearer " + SECRET },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.email ? u.email : null;
  } catch (e) { return null; }
}

async function envoyerMail(to, sujet, html) {
  if (!RESEND_KEY) { console.log("[recap] pas de RESEND_API_KEY"); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: EXPEDITEUR, to: [to], subject: sujet, html: html }),
  });
  if (!r.ok) { console.log("[recap] resend", r.status, await r.text()); return false; }
  return true;
}

function ilya(jours) {
  return new Date(Date.now() - jours * 24 * 3600 * 1000).toISOString();
}

function gabarit(nomCommerce, s) {
  const ligne = (label, valeur) =>
    '<tr><td style="padding:10px 0;border-bottom:1px solid #E7E7E4;color:#5b6470;font-size:14px">' + label +
    '</td><td style="padding:10px 0;border-bottom:1px solid #E7E7E4;text-align:right;font-weight:700;font-size:18px;color:#1B2027">' + valeur + '</td></tr>';
  return '' +
  '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F2F2F0;padding:32px 16px">' +
    '<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;padding:32px 28px;border:1px solid #E7E7E4">' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#E8890A">Votre semaine chez ' + nomCommerce + '</div>' +
      '<h1 style="font-size:24px;margin:8px 0 20px;color:#1B2027;letter-spacing:-.02em">7 jours en un coup d\'œil</h1>' +
      '<table style="width:100%;border-collapse:collapse">' +
        ligne("Passages cette semaine", s.passages) +
        ligne("Nouveaux clients", s.nouveaux) +
        ligne("Récompenses offertes", s.recompenses) +
        ligne("Clients fidèles au total", s.total) +
      '</table>' +
      (s.absents > 0
        ? '<div style="margin-top:20px;background:rgba(252,163,33,.12);border-radius:12px;padding:14px 16px;font-size:13.5px;color:#1B2027">' +
          '<b>' + s.absents + ' client' + (s.absents > 1 ? 's' : '') + '</b> ne ' + (s.absents > 1 ? 'sont' : 'est') +
          ' pas repassé' + (s.absents > 1 ? 's' : '') + ' depuis 3 semaines. Un petit message les fait souvent revenir.</div>'
        : '') +
      '<a href="https://lunat.fr/pro.html" style="display:block;text-align:center;margin-top:24px;background:#FCA321;color:#1B2027;text-decoration:none;font-weight:700;padding:14px;border-radius:12px;font-size:15px">Ouvrir mon espace</a>' +
      '<p style="margin-top:22px;font-size:11.5px;color:#9aa0a6;text-align:center">Propulsé par Studio Cancri · Lunat</p>' +
    '</div>' +
  '</div>';
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const fourni = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
                 (req.query && req.query.secret) || "";
  if (secret && fourni !== secret) return res.status(401).json({ ok: false, raison: "non_autorise" });

  try {
    // on ne récapitule que les commerces réellement en service
    const commerces = await sb("commerces?select=id,nom,slug,objectif,statut&statut=in.(actif,config)");
    let envoyes = 0;

    for (const c of (commerces || [])) {
      const cartes = await sb("cartes?commerce_id=eq." + c.id + "&select=id,cree_le,dernier_tap,tampons");
      const taps7 = await sb("taps?commerce_id=eq." + c.id + "&cree_le=gte." + ilya(7) + "&select=id");

      const stats = {
        passages: (taps7 || []).length,
        nouveaux: (cartes || []).filter((x) => x.cree_le && x.cree_le >= ilya(7)).length,
        recompenses: 0, // approx : cartes revenues à 0 récemment — laissé à 0 faute de journal dédié
        total: (cartes || []).length,
        absents: (cartes || []).filter((x) =>
          x.dernier_tap && x.dernier_tap < ilya(21)).length,
      };

      // pas de données cette semaine ET aucun client → on n'ennuie pas le gérant
      if (stats.total === 0 && stats.passages === 0) continue;

      const proprios = await sb("membres?commerce_id=eq." + c.id + "&role=eq.proprio&select=user_id");
      for (const m of (proprios || [])) {
        const email = await emailDeUser(m.user_id);
        if (!email) continue;
        const ok = await envoyerMail(email, "Votre semaine chez " + c.nom + " 📊", gabarit(c.nom, stats));
        if (ok) envoyes++;
      }
    }

    return res.status(200).json({ ok: true, commerces: (commerces || []).length, emails_envoyes: envoyes });
  } catch (e) {
    console.error("recap error:", e.message || e);
    return res.status(500).json({ ok: false, raison: "erreur_serveur", message: e.message });
  }
};
