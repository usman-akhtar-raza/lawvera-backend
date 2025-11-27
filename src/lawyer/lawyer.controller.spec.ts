import { Test, TestingModule } from '@nestjs/testing';
import { LawyerController } from './lawyer.controller';

describe('LawyerController', () => {
  let controller: LawyerController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LawyerController],
    }).compile();

    controller = module.get<LawyerController>(LawyerController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
