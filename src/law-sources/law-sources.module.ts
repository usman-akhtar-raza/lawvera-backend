import { Module } from '@nestjs/common';
import { LawSourcesController } from './law-sources.controller';
import { LawSourcesService } from './law-sources.service';
import { IngestionQueueService } from './ingestion-queue.service';
import { IngestionProcessorService } from './ingestion-processor.service';

@Module({
  controllers: [LawSourcesController],
  providers: [LawSourcesService, IngestionQueueService, IngestionProcessorService],
  exports: [LawSourcesService],
})
export class LawSourcesModule {}
