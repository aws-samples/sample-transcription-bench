import { Duration } from 'aws-cdk-lib';
import {
  Dashboard,
  GraphWidget,
  Metric,
  MathExpression,
  Alarm,
  ComparisonOperator,
} from 'aws-cdk-lib/aws-cloudwatch';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface WorkerFunctionEntry {
  name: string;
  fn: IFunction;
}

export interface MonitoringProps {
  workers: WorkerFunctionEntry[];
}

export class Monitoring extends Construct {
  public readonly alarms: Alarm[];
  public readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    this.alarms = [];

    // Create error rate alarms for each worker
    for (const worker of props.workers) {
      const errors = new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: { FunctionName: worker.fn.functionName },
        statistic: 'Sum',
        period: Duration.minutes(5),
      });

      const invocations = new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Invocations',
        dimensionsMap: { FunctionName: worker.fn.functionName },
        statistic: 'Sum',
        period: Duration.minutes(5),
      });

      const errorRate = new MathExpression({
        expression: 'IF(invocations > 0, errors / invocations * 100, 0)',
        usingMetrics: { errors, invocations },
        period: Duration.minutes(5),
      });

      const alarm = new Alarm(this, `${worker.name}ErrorRateAlarm`, {
        alarmName: `${worker.name}-error-rate`,
        alarmDescription: `Error rate for ${worker.name} exceeds 5% over 5 minutes`,
        metric: errorRate,
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      this.alarms.push(alarm);
    }

    // Create CloudWatch Dashboard
    this.dashboard = new Dashboard(this, 'TranscriptionDashboard', {
      dashboardName: 'TranscriptionPlatform',
    });

    // Worker invocation counts widget
    this.dashboard.addWidgets(
      new GraphWidget({
        title: 'Worker Invocation Counts',
        left: props.workers.map(
          (w) =>
            new Metric({
              namespace: 'AWS/Lambda',
              metricName: 'Invocations',
              dimensionsMap: { FunctionName: w.fn.functionName },
              statistic: 'Sum',
              period: Duration.minutes(5),
              label: w.name,
            })
        ),
        width: 12,
      }),

      // Worker error rates widget
      new GraphWidget({
        title: 'Worker Error Rates (%)',
        left: props.workers.map(
          (w, i) =>
            new MathExpression({
              expression: `IF(invocations${i} > 0, errors${i} / invocations${i} * 100, 0)`,
              usingMetrics: {
                [`errors${i}`]: new Metric({
                  namespace: 'AWS/Lambda',
                  metricName: 'Errors',
                  dimensionsMap: { FunctionName: w.fn.functionName },
                  statistic: 'Sum',
                  period: Duration.minutes(5),
                }),
                [`invocations${i}`]: new Metric({
                  namespace: 'AWS/Lambda',
                  metricName: 'Invocations',
                  dimensionsMap: { FunctionName: w.fn.functionName },
                  statistic: 'Sum',
                  period: Duration.minutes(5),
                }),
              },
              label: w.name,
              period: Duration.minutes(5),
            })
        ),
        width: 12,
      })
    );

    // Worker duration/latency widget
    this.dashboard.addWidgets(
      new GraphWidget({
        title: 'Worker Average Latency (ms)',
        left: props.workers.map(
          (w) =>
            new Metric({
              namespace: 'AWS/Lambda',
              metricName: 'Duration',
              dimensionsMap: { FunctionName: w.fn.functionName },
              statistic: 'Average',
              period: Duration.minutes(5),
              label: w.name,
            })
        ),
        width: 24,
      })
    );
  }
}
