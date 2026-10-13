/* ============================================================
   ANNIVERSAIRES — outils partagés (carte, pro, caisse, relances)
   On ne garde que le jour et le mois ("MM-JJ"), jamais l'année.
   Le cadeau est valable 7 jours à partir du jour J.
   ============================================================ */

const FENETRE_JOURS = 7;
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/* "AAAA-MM-JJ" à l'heure de Paris */
function jourParis(d) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d || new Date());
}

function bissextile(a) { return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0; }

/* accepte "MM-JJ", {jour, mois}, ou rien → "MM-JJ" valide ou null */
function normaliserAnniv(v) {
  let m, j;
  if (v && typeof v === "object") { m = parseInt(v.mois, 10); j = parseInt(v.jour, 10); }
  else {
    const x = String(v || "").trim().match(/^(\d{1,2})-(\d{1,2})$/);
    if (!x) return null;
    m = parseInt(x[1], 10); j = parseInt(x[2], 10);
  }
  if (!(m >= 1 && m <= 12 && j >= 1)) return null;
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (j > max) return null;
  return String(m).padStart(2, "0") + "-" + String(j).padStart(2, "0");
}

/* "03-12" → "12 mars" */
function texteAnniv(a) {
  const n = normaliserAnniv(a);
  if (!n) return "";
  const m = parseInt(n.slice(0, 2), 10), j = parseInt(n.slice(3), 10);
  return (j === 1 ? "1er" : j) + " " + MOIS[m - 1];
}

/* où en est-on par rapport à l'anniversaire ?
   → null si hors fenêtre, sinon { jour: 0..6, annee, fin: "JJ/MM" } */
function fenetreAnniv(anniversaire, aujourdhui) {
  const n = normaliserAnniv(anniversaire);
  if (!n) return null;
  const auj = aujourdhui || jourParis();
  const an = parseInt(auj.slice(0, 4), 10);
  const tAuj = Date.UTC(an, parseInt(auj.slice(5, 7), 10) - 1, parseInt(auj.slice(8, 10), 10));
  const m = parseInt(n.slice(0, 2), 10);
  const j = parseInt(n.slice(3), 10);
  for (const y of [an, an - 1]) {
    const jj = (m === 2 && j === 29 && !bissextile(y)) ? 28 : j;
    const debut = Date.UTC(y, m - 1, jj);
    const ecart = Math.round((tAuj - debut) / 86400000);
    if (ecart >= 0 && ecart < FENETRE_JOURS) {
      const f = new Date(debut + (FENETRE_JOURS - 1) * 86400000);
      return {
        jour: ecart,
        annee: y,
        fin: String(f.getUTCDate()).padStart(2, "0") + "/" + String(f.getUTCMonth() + 1).padStart(2, "0"),
      };
    }
  }
  return null;
}

/* dans combien de jours (0 = aujourd'hui) */
function joursAvantAnniv(anniversaire, aujourdhui) {
  const n = normaliserAnniv(anniversaire);
  if (!n) return null;
  const auj = aujourdhui || jourParis();
  const an = parseInt(auj.slice(0, 4), 10);
  const tAuj = Date.UTC(an, parseInt(auj.slice(5, 7), 10) - 1, parseInt(auj.slice(8, 10), 10));
  const m = parseInt(n.slice(0, 2), 10), j = parseInt(n.slice(3), 10);
  for (const y of [an, an + 1]) {
    const jj = (m === 2 && j === 29 && !bissextile(y)) ? 28 : j;
    const d = Math.round((Date.UTC(y, m - 1, jj) - tAuj) / 86400000);
    if (d >= 0) return d;
  }
  return null;
}

/* ce que la carte du client doit afficher (null = rien) */
function infoAnniv(carte, commerce) {
  const f = fenetreAnniv(carte && carte.anniversaire);
  if (!f) return null;
  const cadeau = (commerce && commerce.cadeau_anniv && String(commerce.cadeau_anniv).trim()) || null;
  const offert = Number(carte.anniv_offert_annee) === f.annee;
  if (!cadeau && f.jour > 0) return null; // sans cadeau : juste un petit mot le jour J
  return { aujourdhui: f.jour === 0, cadeau: cadeau, offert: offert, fin: f.fin, annee: f.annee };
}

/* le cadeau est-il à donner maintenant ? */
function cadeauAOffrir(carte, commerce) {
  const i = infoAnniv(carte, commerce);
  return !!(i && i.cadeau && !i.offert);
}

module.exports = { FENETRE_JOURS, jourParis, normaliserAnniv, texteAnniv, fenetreAnniv, joursAvantAnniv, infoAnniv, cadeauAOffrir };
