#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { MainStack } from '../lib/main-stack';
import { loadDeploymentConfig } from './context';

try {
  const app = new App();
  const config = loadDeploymentConfig(app);

  new MainStack(app, config.stackName, {
    description: 'Audio Transcription Model Comparison Platform',
    env: {
      account: config.account,
      region: config.region,
    },
    deploymentConfig: config,
  });

  app.synth();
} catch (err) {
  console.error(`cdk-app: ${(err as Error).message}`);
  process.exit(1);
}
