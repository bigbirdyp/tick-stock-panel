import { BookOpenCheck } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'
import { TradeJournalPage } from './page'

const extension: FrontendExtension = {
  id: 'trade.journal',
  apiVersion: 1,
  routes: [{ id: 'trade-journal', path: '/trade-journal', component: TradeJournalPage }],
  navigation: [{ id: 'trade-journal', routeId: 'trade-journal', label: '交易日记', icon: BookOpenCheck, order: 450 }],
}

export default extension
