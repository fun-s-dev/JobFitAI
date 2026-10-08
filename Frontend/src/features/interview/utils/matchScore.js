/**
 * Derives a human-readable match quality label from a numeric score (0-100).
 * Thresholds:
 *   >= 75: Strong match for this role
 *   50-74: Moderate match for this role
 *   < 50:  Weak match for this role
 *
 * @param {number} score
 * @returns {string}
 */
export function getMatchScoreLabel(score) {
    const num = Number(score) || 0;
    if (num >= 75) {
        return "Strong match for this role";
    }
    if (num >= 50) {
        return "Moderate match for this role";
    }
    return "Weak match for this role";
}
