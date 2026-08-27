import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { ApiController } from './api.controller';
import { AdminController } from './admin.controller';
import { TournamentsService } from './tournaments/tournaments.service';
import { DraftService } from './draft/draft.service';
import { DecksService } from './decks/decks.service';
import { MatchesService, RealSrvproClient } from './matches/matches.service';
import { CardsService } from './cards/cards.service';
import { CardPickStatsService } from './cards/card-pick-stats.service';
import { PoolsService } from './pools/pools.service';
import { RealtimeService } from './realtime/realtime.service';
import { config } from './config';
import { setEventHook } from './events/events.service';
import { SmallWorldController } from './small-world/small-world.controller';
import { SmallWorldService } from './small-world/small-world.service';

@Module({
  controllers: [ApiController, AdminController, SmallWorldController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    TournamentsService,
    CardsService,
    CardPickStatsService,
    SmallWorldService,
    PoolsService,
    RealtimeService,
    {
      provide: MatchesService,
      useFactory: () => new MatchesService(new RealSrvproClient(config.srvpro.url, config.srvpro.apiKey)),
    },
    {
      provide: DecksService,
      inject: [CardsService, MatchesService],
      useFactory: (cards: CardsService, matches: MatchesService) => new DecksService(cards, matches),
    },
    {
      provide: DraftService,
      inject: [CardsService, TournamentsService, PoolsService, MatchesService, DecksService],
      useFactory: (
        cards: CardsService,
        tournaments: TournamentsService,
        pools: PoolsService,
        matches: MatchesService,
        decks: DecksService,
      ) => new DraftService(cards, tournaments, pools, matches, decks),
    },
  ],
})
export class AppModule {
  constructor(realtime: RealtimeService) {
    setEventHook((tid, action, payload) => {
      // map domain events to SSE events (dev_docs/07 §2.3).
      // Info-hiding: events broadcast to all subscribers must never carry card
      // contents, deck contents, or other tables' room names — clients refetch
      // their own state instead (dev_docs/05 §3).
      switch (action) {
        case 'phase':
          realtime.emitPhase(tid, payload.status, payload.round ?? 0);
          break;
        case 'cursor':
          realtime.emitPack(tid, {
            packIndex: payload?.packIndex ?? null,
            currentPicker: payload?.playerId ?? null,
            deadlineAt: payload?.deadlineAt ?? null,
          });
          break;
        case 'pick': {
          // passing 模式 pick 事件携带 queues 快照：广播各玩家队列长度（仅数量）
          const queues = payload.queues
            ? Object.fromEntries(Object.entries(payload.queues as Record<string, number[]>).map(([pid, q]) => [pid, q.length]))
            : undefined;
          realtime.emitPick(tid, { playerId: payload.playerId, auto: payload.auto, queues });
          break;
        }
        case 'deadlines':
        case 'deal':
        case 'seat_assign':
          // passing 模式计时重设（暂停/恢复/冻结/解冻）/ 新一轮发堆：通知客户端 refetch
          realtime.emitPack(tid, { deadlines: true });
          break;
        case 'player_rename':
          // Names are public tournament metadata; clients refetch their state
          // instead of putting the new value in a broadcast payload.
          realtime.emitNotice(tid, '玩家显示名称已更新');
          break;
        case 'player_ready':
          // Readiness is public registration metadata; clients refetch the
          // player list so every view shows the same status.
          realtime.emitNotice(tid, '玩家准备状态已更新');
          break;
        case 'player_remove':
          // A registration cancellation changes the public player list.  Only
          // send a generic notice; the removed player's id is not needed by the
          // broadcast and must not be exposed as event payload data.
          realtime.emitNotice(tid, '报名玩家列表已更新');
          break;
        case 'pause':
          realtime.emitPause(tid, payload);
          break;
        case 'deck':
          realtime.emitDeck(tid, { playerId: payload.playerId });
          break;
        case 'match':
          realtime.emitMatch(tid, {
            id: payload.id,
            round: payload.round,
            tableNo: payload.tableNo,
            resultA: payload.resultA,
            resultB: payload.resultB,
            finished: payload.finishedAt !== null,
          });
          break;
      }
    });
  }
}
