'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const nav = [
  { href: '/',          label: 'Dashboard',   icon: '▦' },
  { href: '/trades',    label: 'Trades',      icon: '⇅' },
  { href: '/review',    label: 'Review',      icon: '✓' },
  { href: '/macro',     label: 'Macro',       icon: '◎' },
  { href: '/alerts',    label: 'Alertas',     icon: '⚡' },
  { href: '/journal',   label: 'Journal',     icon: '≡' },
  { href: '/backtest',  label: 'Backtest',    icon: '⟳' },
  { href: '/advisor',   label: 'Advisor IA',  icon: '✦' },
  { href: '/whales',    label: 'Baleias',     icon: '🐳' },
]

export function Sidebar() {
  const path = usePathname()
  return (
    <aside className="w-52 bg-gray-900 border-r border-gray-800 flex flex-col py-6 px-3 shrink-0">
      <div className="mb-8 px-2">
        <span className="text-lg font-bold text-emerald-400">Melhor Trade</span>
        <p className="text-xs text-gray-500 mt-0.5">Swing Trade Desk</p>
      </div>
      <nav className="flex flex-col gap-1">
        {nav.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
              path === item.href
                ? 'bg-emerald-500/20 text-emerald-400 font-medium'
                : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
            )}
          >
            <span className="text-base w-5 text-center">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto px-2 text-xs text-gray-600">
        <p>Scanner: 4h</p>
        <p className="mt-1">15 ativos · Scanner 4h</p>
      </div>
    </aside>
  )
}
