let started = false;

/** Start OTLP exporting only when the audit switch and an endpoint are set. */
export async function startAuditTelemetry(): Promise<void> {
  if (started) return;
  const enabled = ['1', 'true', 'yes'].includes(
    process.env.OPENMAIC_AUDIT_TRACE?.trim().toLowerCase() ?? '',
  );
  if (!enabled) return;

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;

  try {
    // These imports are kept in a Node-only module. The Edge bundle must never
    // load the NodeSDK or the filesystem-backed audit sink.
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');

    const exporter = new OTLPTraceExporter({ url: endpoint });
    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || 'openmaic',
      traceExporter: exporter,
      instrumentations: [],
    });
    sdk.start();
    started = true;
  } catch (error) {
    // Observability must never prevent the application from serving a request.
    console.warn('[OpenMAIC audit] OTLP exporter could not start; local audit continues.', error);
  }
}
