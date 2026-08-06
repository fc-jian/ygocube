import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: { DEFAULT: '#14332a', deep: '#0b1f19', edge: '#1f4a3c' },
        gold: '#d4af37',
      },
    },
  },
  plugins: [],
};

export default config;
