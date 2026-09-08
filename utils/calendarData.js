// Calendrier scolaire Zone B — à mettre à jour chaque année
// Source : education.gouv.fr

const VACANCES_ZONE_B = {
  '2025-2026': [
    { start: '2025-10-18', end: '2025-11-02', label: 'Toussaint' },
    { start: '2025-12-20', end: '2026-01-04', label: 'Noël' },
    { start: '2026-02-14', end: '2026-03-01', label: 'Hiver' },
    { start: '2026-04-11', end: '2026-04-26', label: 'Printemps' },
  ],
  '2026-2027': [
    { start: '2026-10-17', end: '2026-11-01', label: 'Toussaint' },
    { start: '2026-12-19', end: '2027-01-03', label: 'Noël' },
    { start: '2027-02-13', end: '2027-02-28', label: 'Hiver' },
    { start: '2027-04-17', end: '2027-05-02', label: 'Printemps' },
  ],
}

const JOURS_FERIES = {
  '2025-2026': [
    '2025-11-11',
    '2026-04-06',
    '2026-05-01',
    '2026-05-08',
    '2026-05-14',
    '2026-05-25',
  ],
  '2026-2027': [
    '2026-11-01',
    '2026-11-11',
    '2027-03-29',
    '2027-05-01',
    '2027-05-06',
    '2027-05-08',
    '2027-05-17',
  ],
}

/**
 * Retourne 'holiday' | 'vacation' | null selon la date et le label de l'année scolaire.
 */
function getSessionStatus(dateStr, yearLabel) {
  if ((JOURS_FERIES[yearLabel] || []).includes(dateStr)) return 'holiday'
  for (const vac of (VACANCES_ZONE_B[yearLabel] || [])) {
    if (dateStr >= vac.start && dateStr <= vac.end) return 'vacation'
  }
  return null
}

module.exports = { VACANCES_ZONE_B, JOURS_FERIES, getSessionStatus }