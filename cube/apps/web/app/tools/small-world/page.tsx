import type { Metadata } from 'next';
import { SmallWorldCalculator } from '@/components/SmallWorldCalculator';

export const metadata: Metadata = {
  title: '小世界现象检索计算器',
  description: '根据卡组和手牌 code 计算游戏王小世界现象的所有检索路径。',
};

export default function SmallWorldPage() {
  return <SmallWorldCalculator />;
}
