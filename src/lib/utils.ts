import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { SetupGrade, Bias } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function fmtPrice(value: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
}

export function fmtPct(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function fmtUSD(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export function gradeColor(grade: SetupGrade | string): string {
  const map: Record<string, string> = {
    'A+': 'bg-emerald-500 text-white',
    'A':  'bg-green-500 text-white',
    'B':  'bg-yellow-500 text-black',
    'C':  'bg-orange-500 text-white',
    'invalid': 'bg-gray-500 text-white',
  }
  return map[grade] ?? 'bg-gray-500 text-white'
}

export function biasColor(bias: Bias | string): string {
  if (bias === 'ALTISTA')      return 'text-emerald-400'
  if (bias === 'BAIXISTA')     return 'text-red-400'
  return 'text-yellow-400'
}

export function macroScoreColor(score: number): string {
  if (score >= 2)  return 'text-emerald-400'
  if (score === 1) return 'text-green-400'
  if (score === 0) return 'text-yellow-400'
  if (score === -1) return 'text-orange-400'
  return 'text-red-400'
}

export function pnlColor(value: number): string {
  return value >= 0 ? 'text-emerald-400' : 'text-red-400'
}
