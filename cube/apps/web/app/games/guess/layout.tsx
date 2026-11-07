import type { Metadata } from 'next';
import './guess.css';

export const metadata: Metadata = {
  title: 'Guess the Card',
  description: 'A Yu-Gi-Oh! card guessing game for two to eight players.',
};

export default function GuessLayout({ children }: { children: React.ReactNode }) {
  return children;
}
