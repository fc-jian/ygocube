import type { Metadata } from 'next';
import '../guess/guess.css';
import './dg.css';

export const metadata: Metadata = {
  title: 'Draw & Guess',
  description: 'Draw Yu-Gi-Oh! cards and guess each other’s sketches.',
};

export default function DgLayout({ children }: { children: React.ReactNode }) {
  return children;
}
