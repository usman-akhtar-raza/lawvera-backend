import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';

const server = express();
let app;

async function bootstrap() {
  if (!app) {
    const expressAdapter = new ExpressAdapter(server);
    app = await NestFactory.create(AppModule, expressAdapter, {
      cors: true,
      logger: ['error', 'warn', 'log'],
    });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  }
  return server;
}

export default async function handler(req: any, res: any) {
  try {
    const instance = await bootstrap();
    return instance(req, res);
  } catch (error) {
    console.error('Serverless bootstrap error:', error);
    res.status(500).json({
      message: 'Server initialization failed',
      error: error.message || 'Unknown error',
    });
  }
}
