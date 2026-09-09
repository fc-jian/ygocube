import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { AuthedRequest, Public } from "../auth/auth.guard";
import { DuelService } from "./duel.service";
@Controller()
export class DuelController {
  constructor(private duel: DuelService) {}
  @Public()
  @Get("public/duel/rooms/:room")
  room(@Param("room") room: string) {
    return this.duel.roomInfo(room);
  }
  @Public()
  @Post("public/duel/resolve")
  resolve(@Body() body: any) {
    return this.duel.resolveRoom(body);
  }
  @Public()
  @Post("public/duel/watch")
  observer(@Body() body: any) {
    return this.duel.standaloneWatch(body?.room);
  }
  @Public()
  @Get("public/duel/search")
  search(@Query("q") q: string) {
    if (typeof q !== "string" || q.length > 100) throw new Error("BAD_PAYLOAD");
    return this.duel.searchCards(q);
  }
  @Public()
  @Get("public/duel/options")
  options() {
    return this.duel.standaloneOptions();
  }
  @Public()
  @Post("public/duel/join")
  join(@Body() body: any) {
    return this.duel.standaloneJoin(body);
  }
  @Public()
  @Post("public/duel/session")
  standalone(@Body() body: any) {
    if (typeof body?.credential !== "string" || body.credential.length > 100)
      throw new Error("BAD_PAYLOAD");
    return this.duel.standaloneSession(body.credential);
  }
  @Post("t/:tid/matches/:mid/duel-session")
  session(
    @Param("tid", ParseIntPipe)
    tid: number,
    @Param("mid", ParseIntPipe)
    mid: number,
    @Req()
    req: AuthedRequest,
  ) {
    return this.duel.session(tid, mid, req.identity!.playerId);
  }
  @Public()
  @Post("public/t/:tid/matches/:mid/watch-session")
  watch(
    @Param("tid", ParseIntPipe)
    tid: number,
    @Param("mid", ParseIntPipe)
    mid: number,
  ) {
    return this.duel.session(tid, mid);
  }
  @Public()
  @Get("public/t/:tid/matches/:mid/replay")
  replay(
    @Param("tid", ParseIntPipe)
    tid: number,
    @Param("mid", ParseIntPipe)
    mid: number,
  ) {
    return this.duel.replay(tid, mid);
  }
  @Post("admin/t/:tid/matches/:mid/replay/delete")
  delete(
    @Param("tid", ParseIntPipe)
    tid: number,
    @Param("mid", ParseIntPipe)
    mid: number,
  ) {
    return this.duel.deleteReplay(tid, mid);
  }
  @Public()
  @Post("public/duel/descriptions")
  descriptions(
    @Body()
    body: any,
  ) {
    if (
      !Array.isArray(body?.ids) ||
      body.ids.length > 256 ||
      body.ids.some(
        (v: any) => !Number.isSafeInteger(v) || v < 0 || v > 0xffffffff,
      )
    )
      throw new Error("BAD_PAYLOAD");
    return this.duel.descriptions(body.ids);
  }
  @Public()
  @Post("public/duel/cards")
  cards(
    @Body()
    body: any,
  ) {
    if (
      !Array.isArray(body?.codes) ||
      body.codes.length > 256 ||
      body.codes.some((v: any) => !Number.isSafeInteger(v) || v <= 0)
    )
      throw new Error("BAD_PAYLOAD");
    return this.duel.cardInfo(body.codes);
  }
  @Public()
  @Post("public/duel/declare")
  declare(
    @Body()
    body: any,
  ) {
    if (
      typeof body?.q !== "string" ||
      body.q.length > 100 ||
      !Array.isArray(body.opcodes) ||
      body.opcodes.length > 255 ||
      body.opcodes.some(
        (v: any) => !Number.isSafeInteger(v) || v < 0 || v > 0xffffffff,
      )
    )
      throw new Error("BAD_PAYLOAD");
    return this.duel.declare(body.q, body.opcodes);
  }
}
