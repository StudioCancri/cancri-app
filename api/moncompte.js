/* ============================================================
   API CANCRI — /api/moncompte
   Portail client : retrouver ses cartes de fidélité avec son
   email, quel que soit le téléphone.

   Actions :
   - mes_cartes  : toutes les cartes liées à l'email vérifié
   - rattacher   : lie des cartes (jetons locaux) à cet email
   ============================================================ */

function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

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

/* renvoie l'email vérifié du porteur du token, ou null */
async function emailDepuisToken(token) {
  if (!token) return null;
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SECRET, Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.email ? u.email.toLowerCase().trim() : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ ok: true, info: "API mon compte" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const email = await emailDepuisToken(token);
    if (!email) return res.status(401).json({ ok: false, raison: "non_connecte" });

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const action = body.action;

    /* ---- RATTACHER des cartes trouvées sur cet appareil ---- */
    if (action === "rattacher") {
      const jetons = Array.isArray(body.jetons) ? body.jetons.slice(0, 20) : [];
      let ajoutees = 0;
      for (const j of jetons) {
        if (!j || typeof j !== "string") continue;
        const c = await sb("cartes?jeton=eq." + encodeURIComponent(j) + "&select=id,email");
        if (!c || !c[0]) continue;
        /* on ne vole pas la carte de quelqu'un d'autre */
        if (c[0].email && c[0].email.toLowerCase().trim() !== email) continue;
        if (c[0].email && c[0].email.toLowerCase().trim() === email) continue;
        await sb("cartes?id=eq." + c[0].id, { method: "PATCH", body: { email: email } });
        ajoutees++;
      }
      return res.status(200).json({ ok: true, ajoutees: ajoutees });
    }

    /* ---- MES CARTES ---- */
    if (action === "mes_cartes") {
      const cartes = await sb(
        "cartes?email=ilike." + encodeURIComponent(email) +
        "&select=id,jeton,prenom,tampons,dernier_tap,commerce_id&order=dernier_tap.desc"
      );
      const liste = [];
      for (const c of (cartes || [])) {
        const com = await sb("commerces?id=eq." + c.commerce_id +
          "&select=nom,slug,unite,objectif,recompense,couleur_fond,couleur_texte,couleur_label,adresse,message_actuel");
        if (!com || !com[0]) continue;
        const m = com[0];
        liste.push({
          jeton: c.jeton,
          prenom: c.prenom,
          tampons: c.tampons,
          dernier_tap: c.dernier_tap,
          commerce: m.nom,
          slug: m.slug,
          unite: m.unite,
          objectif: m.objectif,
          recompense: m.recompense,
          adresse: m.adresse || "",
          message: m.message_actuel || "",
          fond: m.couleur_fond || "rgb(255,255,255)",
          texte: m.couleur_texte || "rgb(0,0,0)",
          label: m.couleur_label || "rgb(0,0,0)",
        });
      }
      return res.status(200).json({ ok: true, email: email, cartes: liste });
    }

    return res.status(200).json({ ok: false, raison: "action_inconnue" });
  } catch (e) {
    console.error("moncompte error:", e.message || e);
    return res.status(500).json({ ok: false, raison: "erreur_serveur", message: e.message });
  }
};
