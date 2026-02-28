import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { MAX_UPLOAD_BYTES } from './law-sources.constants';
import { UploadLawSourceDto } from './dto/upload-law-source.dto';
import { UpdateLawSourceDto } from './dto/update-law-source.dto';
import { LawSourcesService } from './law-sources.service';
import type { LawSourceUploadFile } from './law-source-file.type';

@Controller('law-sources')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class LawSourcesController {
  constructor(private readonly lawSourcesService: LawSourcesService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
      },
    }),
  )
  upload(
    @UploadedFile() file: LawSourceUploadFile,
    @Body() dto: UploadLawSourceDto,
  ) {
    return this.lawSourcesService.upload(file, dto);
  }

  @Get()
  list() {
    return this.lawSourcesService.list();
  }

  @Patch(':id')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLawSourceDto,
  ) {
    return this.lawSourcesService.updateStatus(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.lawSourcesService.delete(id);
  }
}
