/* ============================================================
   API CANCRI — /api/pass?jeton=XXX
   Génère et renvoie le vrai pass Apple Wallet (.pkpass) d'une
   carte, avec ses tampons réels et la grille dessinée.

   Le bouton "Ajouter à Apple Wallet" de carte.html pointe ici.

   Variables Vercel nécessaires :
   SUPABASE_URL, SUPABASE_SECRET
   PASS_WWDR, PASS_CERT, PASS_KEY  (base64 des .pem)
   PASS_KEY_PASSPHRASE  (optionnel)
   PASS_TYPE_ID, PASS_TEAM_ID, PASS_ORG, APP_URL
   ============================================================ */

const path = require("path");
const fs = require("fs");
const { PKPass } = require("passkit-generator");
const { capacites } = require("./plans");
let sharp;
try { sharp = require("sharp"); } catch (e) { sharp = null; }

/* ---------- Supabase (lecture seule ici) ---------- */
function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

async function sb(chemin) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    headers: { apikey: SECRET, Authorization: "Bearer " + SECRET },
  });
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* ---------- décodage des certificats depuis les variables ---------- */
function certDepuisEnv(nom) {
  const b64 = (process.env[nom] || "").trim();
  if (!b64) throw new Error("Variable manquante : " + nom);
  return Buffer.from(b64, "base64");
}

/* ---------- couleurs → rgb array pour le dessin ---------- */
function rgbArray(rgbStr, fallback) {
  const m = (rgbStr || "").match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return fallback;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

/* ---------- SVG de la grille de tampons ---------- */
/* ============================================================
   MODE POINTS : ce que la carte Wallet affiche à la place des tampons
   ============================================================ */
function listeRecompensesPass(commerce) {
  let r = commerce.recompenses_points;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch (e) { r = []; } }
  return (Array.isArray(r) ? r : []).filter(function (x) { return x && x.cout > 0; })
    .sort(function (a, b) { return a.cout - b.cout; });
}
function estModePoints(commerce) {
  return commerce.mode === "points" && capacites(commerce).points;
}
/* barre de progression vers les récompenses (aucun texte : rendu fiable partout) */
function svgPoints(points, recs, fondRgb, labelRgb) {
  const W = 1125, H = 432;
  const fond = "rgb(" + fondRgb.join(",") + ")", label = "rgb(" + labelRgb.join(",") + ")";
  const max = recs.length ? recs[recs.length - 1].cout : 100;
  const x0 = 120, x1 = W - 120, y = H / 2, ep = 30, R = 44;
  const ratio = Math.max(0, Math.min(1, points / max));
  let els = '<rect width="' + W + '" height="' + H + '" fill="' + fond + '"/>';
  els += '<rect x="' + x0 + '" y="' + (y - ep / 2) + '" width="' + (x1 - x0) + '" height="' + ep + '" rx="' + ep / 2 + '" fill="' + label + '" fill-opacity="0.25"/>';
  if (ratio > 0) {
    els += '<rect x="' + x0 + '" y="' + (y - ep / 2) + '" width="' + Math.max(ep, (x1 - x0) * ratio) + '" height="' + ep + '" rx="' + ep / 2 + '" fill="' + label + '"/>';
  }
  for (const r of recs) {
    const cx = x0 + (x1 - x0) * (r.cout / max);
    const atteint = points >= r.cout;
    els += '<circle cx="' + cx + '" cy="' + y + '" r="' + R + '" fill="' + (atteint ? label : fond) + '" stroke="' + label + '" stroke-width="8"/>';
    if (atteint) {
      els += '<path d="M ' + (cx - R * 0.38) + ' ' + (y + R * 0.02) + ' L ' + (cx - R * 0.08) + ' ' + (y + R * 0.34) + ' L ' + (cx + R * 0.42) + ' ' + (y - R * 0.3) +
        '" fill="none" stroke="' + fond + '" stroke-width="' + R * 0.26 + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + els + '</svg>';
}
/* les champs du recto, selon le mode */
function champsRecto(pass, carte, commerce) {
  const dispo = carte.recompenses_dispo || 0;
  if (estModePoints(commerce)) {
    const recs = listeRecompensesPass(commerce);
    const pts = carte.points || 0;
    const utilisables = recs.filter(function (x) { return x.cout <= pts; });
    const prochaine = recs.find(function (x) { return x.cout > pts; });
    pass.headerFields.push({ key: "solde", label: "POINTS", value: pts, changeMessage: "Tu as maintenant %@ points" });
    pass.secondaryFields.push({ key: "membre", label: "MEMBRE", value: carte.prenom || "Client" });
    if (utilisables.length) {
      pass.secondaryFields.push({ key: "reward", label: "À UTILISER", value: utilisables[utilisables.length - 1].nom, changeMessage: "Récompense disponible : %@" });
    } else if (prochaine) {
      pass.secondaryFields.push({ key: "reward", label: "PROCHAINE RÉCOMPENSE", value: prochaine.nom + " à " + prochaine.cout + " pts" });
    }
    return;
  }
  pass.headerFields.push({ key: "solde", label: commerce.unite, value: carte.tampons + "/" + commerce.objectif });
  pass.secondaryFields.push(
    { key: "membre", label: "MEMBRE", value: carte.prenom || "Client" },
    { key: "reward", label: "RÉCOMPENSE", value: commerce.recompense }
  );
  if (dispo > 0) {
    pass.auxiliaryFields.push({ key: "reserve", label: "EN RÉSERVE", value: dispo + (dispo > 1 ? " récompenses" : " récompense"),
      changeMessage: "Récompense débloquée, tu en as %@" });
  }
}
function texteRegle(commerce) {
  if (estModePoints(commerce)) {
    return "Au comptoir, l'équipe saisit votre achat, puis vous posez votre téléphone sur la pastille : vous gagnez vos points. Utilisez-les quand vous voulez contre une récompense.";
  }
  return "Posez votre téléphone sur la pastille au comptoir pour gagner vos tampons. À " + commerce.objectif + ", votre récompense vous attend, et vous pouvez la garder pour plus tard.";
}

function svgStrip(tampons, objectif, fondRgb, labelRgb) {
  const W = 1125, H = 432;
  const fond = "rgb(" + fondRgb.join(",") + ")";
  const label = "rgb(" + labelRgb.join(",") + ")";
  const rows = objectif <= 6 ? 1 : 2;
  const cols = Math.ceil(objectif / rows);
  const cellW = W / cols, cellH = H / rows;
  const D = Math.min(cellW, cellH) * 0.62, R = D / 2;
  let els = '<rect width="' + W + '" height="' + H + '" fill="' + fond + '"/>';
  for (let i = 0; i < objectif; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    const cx = col * cellW + cellW / 2, cy = row * cellH + cellH / 2;
    if (i < tampons) {
      els += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="' + label + '"/>';
      const p1x = cx - R * 0.38, p1y = cy + R * 0.02;
      const p2x = cx - R * 0.08, p2y = cy + R * 0.34;
      const p3x = cx + R * 0.42, p3y = cy - R * 0.3;
      els += '<path d="M ' + p1x + ' ' + p1y + ' L ' + p2x + ' ' + p2y + ' L ' + p3x + ' ' + p3y +
             '" fill="none" stroke="' + fond + '" stroke-width="' + D * 0.13 +
             '" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      els += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="' + label +
             '" stroke-opacity="0.5" stroke-width="7" stroke-dasharray="16 13"/>';
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
         '" viewBox="0 0 ' + W + ' ' + H + '">' + els + '</svg>';
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    const jeton = (req.query && req.query.jeton) || "";
    if (!jeton) return res.status(400).send("jeton manquant");

    /* carte + commerce */
    const cartes = await sb("cartes?jeton=eq." + encodeURIComponent(jeton) + "&select=*");
    if (!cartes || !cartes[0]) return res.status(404).send("carte inconnue");
    const carte = cartes[0];
    const commerces = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
    const commerce = commerces[0];

    const fondRgb = rgbArray(commerce.couleur_fond, [42, 29, 20]);
    const labelRgb = rgbArray(commerce.couleur_label, [240, 223, 198]);
    const fgRgb = rgbArray(commerce.couleur_texte, [251, 249, 244]);

    /* dossier d'images : pass-assets/<slug>/ sinon pass-assets/ (fallback) */
    const dossierCommerce = path.join(process.cwd(), "pass-assets", commerce.slug || "");
    const dossierDefaut = path.join(process.cwd(), "pass-assets");

    /* on rassemble tous les buffers d'images */
    const buffers = {};
    const imgs = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png"];
    for (const f of imgs) {
      const propre = path.join(dossierCommerce, f);
      const defaut = path.join(dossierDefaut, f);
      if (fs.existsSync(propre)) buffers[f] = fs.readFileSync(propre);
      else if (fs.existsSync(defaut)) buffers[f] = fs.readFileSync(defaut);
    }

    /* strip = grille dessinée à la volée */
    if (sharp) {
      const svg = Buffer.from(estModePoints(commerce)
      ? svgPoints(carte.points || 0, listeRecompensesPass(commerce), fondRgb, labelRgb)
      : svgStrip(carte.tampons, commerce.objectif, fondRgb, labelRgb));
      buffers["strip.png"] = await sharp(svg).resize(375, 144).png().toBuffer();
      buffers["strip@2x.png"] = await sharp(svg).resize(750, 288).png().toBuffer();
      buffers["strip@3x.png"] = await sharp(svg).resize(1125, 432).png().toBuffer();
    }

    /* pass.json (le modèle) sous forme de buffer */
    buffers["pass.json"] = Buffer.from(JSON.stringify({
      formatVersion: 1,
      passTypeIdentifier: process.env.PASS_TYPE_ID,
      teamIdentifier: process.env.PASS_TEAM_ID,
      organizationName: commerce.nom,
      description: "Carte de fidélité — " + commerce.nom,
      serialNumber: carte.jeton,
      logoText: commerce.nom,
      backgroundColor: "rgb(" + fondRgb.join(", ") + ")",
      foregroundColor: "rgb(" + fgRgb.join(", ") + ")",
      labelColor: "rgb(" + labelRgb.join(", ") + ")",
      webServiceURL: (process.env.APP_URL || ""),
      authenticationToken: carte.jeton,
      storeCard: {},
    }));

    /* construction du pass à partir des buffers */
    const pass = new PKPass(buffers, {
      wwdr: certDepuisEnv("PASS_WWDR"),
      signerCert: certDepuisEnv("PASS_CERT"),
      signerKey: certDepuisEnv("PASS_KEY"),
      signerKeyPassphrase: process.env.PASS_KEY_PASSPHRASE || undefined,
    });

    /* champs */
    champsRecto(pass, carte, commerce);

    /* message affiché au dos : celui de la carte prime, sinon celui du commerce */
    const messageCarte = (carte.message_perso && carte.message_perso.trim())
      ? carte.message_perso.trim()
      : ((commerce.message_actuel && commerce.message_actuel.trim()) ? commerce.message_actuel.trim() : "");
    if (messageCarte) {
      pass.backFields.push({ key: "actu", label: "À ne pas manquer", value: messageCarte, changeMessage: "%@" });
    }
    /* lien de secours : reconnecte ce téléphone à sa carte (Safari peut oublier) */
    const lienRetrouver = "https://lunat.fr" +
      "/carte.html?c=" + encodeURIComponent(commerce.slug) + "&j=" + encodeURIComponent(carte.jeton);
    pass.backFields.push(
      { key: "regle", label: "Comment ça marche", value: texteRegle(commerce) },
      { key: "retrouver", label: "Votre carte sur ce téléphone",
        value: "Si on vous redemande de vous inscrire, touchez ce lien : " + lienRetrouver,
        attributedValue: 'Si on vous redemande de vous inscrire : <a href="' + lienRetrouver + '">Retrouver ma carte</a>' },
      { key: "studio", label: "Propulsé par", value: "Studio Cancri" }
    );

    /* mise à jour automatique (Phase C) : on branche déjà la webServiceURL */
    if (process.env.APP_URL) {
      pass.setBarcodes({ message: carte.jeton, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" });
    }

    const buffer = pass.getAsBuffer();
    res.setHeader("Content-Type", "application/vnd.apple.pkpass");
    res.setHeader("Content-Disposition", 'attachment; filename="carte.pkpass"');
    return res.status(200).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Erreur génération pass : " + (e.message || e));
  }
};
