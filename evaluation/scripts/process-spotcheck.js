const fs = require('fs');
const path = require('path');

function processSpotcheck() {
  const spotcheckPath = path.join(__dirname, '../spotcheck.md');
  if (!fs.existsSync(spotcheckPath)) {
    throw new Error('evaluation/spotcheck.md does not exist.');
  }

  const content = fs.readFileSync(spotcheckPath, 'utf8');
  const caseBlocks = content.split(/### Case \d+:/).slice(1);

  let agreed = 0;
  let disagreed = 0;
  let unticked = 0;
  const disagreements = [];

  for (const block of caseBlocks) {
    const idMatch = block.match(/`([c]-\d+)`/);
    const id = idMatch ? idMatch[1] : 'unknown';

    const agreeTicked = block.includes('- [x] agree') || block.includes('- [X] agree');
    const disagreeTicked = block.includes('- [x] disagree') || block.includes('- [X] disagree');

    if (agreeTicked && !disagreeTicked) {
      agreed++;
    } else if (disagreeTicked && !agreeTicked) {
      disagreed++;
      const notesMatch = block.match(/Reviewer Notes \(if disagree\):\s*([^\n\r]+)/);
      disagreements.push({
        id,
        notes: notesMatch ? notesMatch[1].trim() : 'No notes provided',
      });
    } else {
      unticked++;
    }
  }

  const totalEvaluated = agreed + disagreed;
  const agreementRate = totalEvaluated > 0 ? (agreed / totalEvaluated) * 100 : 0;

  const result = {
    totalCases: caseBlocks.length,
    agreed,
    disagreed,
    unticked,
    agreementRate: Number(agreementRate.toFixed(1)),
    disagreements,
    isComplete: unticked === 0 && caseBlocks.length > 0,
  };

  console.log('--- Spot-Check Processing Results ---');
  console.log(`Total sample cases: ${result.totalCases}`);
  console.log(`Agreed: ${result.agreed}`);
  console.log(`Disagreed: ${result.disagreed}`);
  console.log(`Unticked (pending): ${result.unticked}`);
  if (totalEvaluated > 0) {
    console.log(`Agreement Rate: ${result.agreementRate}% (n=${totalEvaluated})`);
  } else {
    console.log('Status: Pending human review (all boxes unticked).');
  }

  return result;
}

if (require.main === module) {
  processSpotcheck();
}

module.exports = { processSpotcheck };
