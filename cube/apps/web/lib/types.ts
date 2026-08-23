export interface CardInfo {
  code: number;
  name: string;
  type: number;
  desc: string;
  level: number;
  lscale: number;
  rscale: number;
  linkMarkers: number;
  race: number;
  attribute: number;
  atk: number;
  def: number;
  alias?: number;
  setCodes: number[];
  setNames: string[];
  inPool?: boolean;
  poolStatus?: 'in_pool' | 'not_in_pool';
  pickStats?: {
    poolId: number;
    poolName: string;
    averagePickPosition: number;
    averagePickPercentage: number;
    packCount: number;
    tournamentCount: number;
    sampleCount: number;
  }[];
}
