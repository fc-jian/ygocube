'use client';

import Link from 'next/link';
import { ReactNode, useEffect, useState } from 'react';
import { GUESS_PATH } from './guess-client';
import { GuessLanguage, guessText } from './guess-text';

const LANGUAGE_KEY = 'yc_guess_language';

export function useGuessLanguage() {
  const [language, setLanguage] = useState<GuessLanguage>('zh');
  useEffect(() => {
    if (localStorage.getItem(LANGUAGE_KEY) === 'en') setLanguage('en');
  }, []);
  function changeLanguage(value: GuessLanguage) {
    localStorage.setItem(LANGUAGE_KEY, value);
    setLanguage(value);
  }
  return { language, changeLanguage, text: guessText[language] };
}

export function GuessFrame({ children, language, changeLanguage }: {
  children: ReactNode;
  language: GuessLanguage;
  changeLanguage: (language: GuessLanguage) => void;
}) {
  return (
    <main className="guess-shell" lang={language === 'zh' ? 'zh-CN' : 'en'}>
      <header className="guess-nav">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <Link href="/" className="guess-brand">YGO CUBE</Link>
          <Link href={GUESS_PATH} className="guess-nav-link">{guessText[language].lobby}</Link>
          <Link href={`${GUESS_PATH}/pools`} className="guess-nav-link">{guessText[language].pools}</Link>
        </div>
        <div className="guess-language" aria-label="Language / 语言">
          <button type="button" aria-pressed={language === 'zh'} onClick={() => changeLanguage('zh')}>中文</button>
          <button type="button" aria-pressed={language === 'en'} onClick={() => changeLanguage('en')}>EN</button>
        </div>
      </header>
      {children}
    </main>
  );
}
