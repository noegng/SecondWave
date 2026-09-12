import { readFile } from 'node:fs/promises'
import { formatBoard, formatReport } from './report.mjs'
import {
  crisisBroker,
  crisisLoans,
  crisisVault,
  healthyBroker,
  healthyLoans,
  healthyVault,
  nowRipple,
  speculativeBroker,
  speculativeLoans,
  speculativeVault,
} from '../test/fixtures.mjs'

const DEMO_OFFER = { shares: 1000, discount: 0.03 }
const STRESS = 0.5

const demoCases = [
  {
    title: 'Broker A — bon élève',
    vault: healthyVault,
    broker: healthyBroker,
    loans: healthyLoans,
    offer: DEMO_OFFER,
    nowRipple,
    stressRate: STRESS,
  },
  {
    title: 'Broker B — spéculatif',
    vault: speculativeVault,
    broker: speculativeBroker,
    loans: speculativeLoans,
    offer: { shares: 1000, discount: 0.08 },
    nowRipple,
    stressRate: STRESS,
  },
  {
    title: 'Broker C — crise',
    vault: crisisVault,
    broker: crisisBroker,
    loans: crisisLoans,
    offer: { shares: 1000, discount: 0.2 },
    nowRipple,
    stressRate: STRESS,
  },
]

async function main() {
  const file = process.argv[2]
  if (file) {
    const dump = JSON.parse(await readFile(file, 'utf8'))
    const cases = dump.cases ?? [dump]
    console.log(formatBoard(cases))
    return
  }
  console.log('SecondWave analyst — 3 scénarios (fixtures, hors chaîne)\n')
  console.log(formatBoard(demoCases))
  console.log('\nDump ledger Hugo : npm run analyst -- path/to/world.json')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
