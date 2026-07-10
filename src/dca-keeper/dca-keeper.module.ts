/**
 * DCAKeeperModule — 積立(DCA) keeper を NestJS に組み込むモジュール (スケッチ)。
 *
 * app.module.ts で ScheduleModule.forRoot() を有効化した上で imports に追加する:
 *
 *   @Module({
 *     imports: [ScheduleModule.forRoot(), DCAKeeperModule],
 *   })
 *   export class AppModule {}
 */
import { Module } from '@nestjs/common';
import { DCAKeeperService } from './dca-keeper.service';

@Module({
  providers: [DCAKeeperService],
  exports: [DCAKeeperService],
})
export class DCAKeeperModule {}
