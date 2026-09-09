'use client';
import { useParams } from 'next/navigation';
import { DuelClient } from '@/components/duel/DuelClient';
export default function Page(){const p=useParams<{tid:string;pid:string;mid:string}>();return <DuelClient tid={p.tid} mid={p.mid} mode="watch"/>;}
