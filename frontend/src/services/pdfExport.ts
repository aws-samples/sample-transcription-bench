import html2canvas from 'html2canvas-pro';
import jsPDF from 'jspdf';

/**
 * Render a DOM element to a multi-page A4 PDF with a clean, professional
 * report style. When pdfMode is active on the page, the printable container
 * switches to a white-background layout optimized for readability on paper
 * and screen PDF viewers.
 *
 * Implementation notes:
 * - Uses html2canvas-pro (active fork) because the original html2canvas chokes
 *   on modern CSS color functions like oklch / lab.
 * - Renders at 2x scale for crisp text on retina; canvas is scaled to fit A4.
 * - Elements with data-pdf-ignore are excluded from capture.
 * - Before capture, injects a temporary class that forces print-friendly styles.
 */
export interface DownloadOptions {
  /** Filename without extension. */
  fileName: string;
  /** Background color used to fill page margins. */
  backgroundColor?: string;
}

const PDF_CLASS = 'pdf-export-mode';

/**
 * Inject temporary styles that transform the dark UI into a print-friendly
 * report. These get removed after capture.
 */
function injectPdfStyles(): HTMLStyleElement {
  const style = document.createElement('style');
  style.id = 'pdf-export-styles';
  style.textContent = `
    .${PDF_CLASS} {
      background: #ffffff !important;
      color: #1a1a1a !important;
      padding: 48px 40px !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      border: none !important;
    }

    .${PDF_CLASS} * {
      border-color: rgba(0, 0, 0, 0.08) !important;
    }

    /* Header */
    .${PDF_CLASS} h1 {
      color: #111827 !important;
      font-size: 24px !important;
      font-weight: 700 !important;
      letter-spacing: -0.03em !important;
      margin-bottom: 4px !important;
    }

    .${PDF_CLASS} h2 {
      color: #374151 !important;
      font-size: 14px !important;
      font-weight: 600 !important;
    }

    .${PDF_CLASS} h3 {
      color: #1f2937 !important;
      font-size: 13px !important;
      font-weight: 600 !important;
    }

    /* Panels */
    .${PDF_CLASS} [style*="backdrop-filter"],
    .${PDF_CLASS} [style*="rgba(28"] {
      background: #fafafa !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      border: 1px solid #e5e7eb !important;
      box-shadow: none !important;
    }

    /* Text */
    .${PDF_CLASS} p,
    .${PDF_CLASS} span {
      color: #374151 !important;
    }

    .${PDF_CLASS} [style*="rgba(255,255,255,0.9"] {
      color: #111827 !important;
    }

    .${PDF_CLASS} [style*="rgba(255,255,255,0.7"] {
      color: #374151 !important;
    }

    .${PDF_CLASS} [style*="rgba(255,255,255,0.5"],
    .${PDF_CLASS} [style*="rgba(255,255,255,0.4"],
    .${PDF_CLASS} [style*="rgba(255,255,255,0.3"] {
      color: #6b7280 !important;
    }

    /* Badges */
    .${PDF_CLASS} [style*="text-transform: uppercase"] {
      border: 1px solid currentColor !important;
      background: transparent !important;
      opacity: 0.8 !important;
    }

    /* Metrics values — keep their semantic colors but darken them for paper */
    .${PDF_CLASS} [style*="color: #34d399"],
    .${PDF_CLASS} [style*="color: rgb(52, 211, 153)"] {
      color: #059669 !important;
    }

    .${PDF_CLASS} [style*="color: #f87171"],
    .${PDF_CLASS} [style*="color: rgb(248, 113, 113)"] {
      color: #dc2626 !important;
    }

    .${PDF_CLASS} [style*="color: #fbbf24"],
    .${PDF_CLASS} [style*="color: rgb(251, 191, 36)"] {
      color: #d97706 !important;
    }

    .${PDF_CLASS} [style*="color: #818cf8"],
    .${PDF_CLASS} [style*="color: rgb(129, 140, 248)"] {
      color: #4f46e5 !important;
    }

    /* Diff viewer */
    .${PDF_CLASS} [style*="rgba(248, 113, 113"] {
      background: rgba(220, 38, 38, 0.08) !important;
      color: #dc2626 !important;
    }

    .${PDF_CLASS} [style*="rgba(52, 211, 153"] {
      background: rgba(5, 150, 105, 0.08) !important;
      color: #059669 !important;
    }

    /* Report branding footer — appended by JS */
    .${PDF_CLASS} .pdf-footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: #9ca3af;
    }
  `;
  document.head.appendChild(style);
  return style;
}

function addReportFooter(container: HTMLElement, jobId: string): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'pdf-footer';
  footer.innerHTML = `
    <span>TranscribeBench Report</span>
    <span>Job ${jobId} · Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
  `;
  container.appendChild(footer);
  return footer;
}

export async function downloadElementAsPdf(
  element: HTMLElement,
  { fileName, backgroundColor = '#ffffff' }: DownloadOptions,
): Promise<void> {
  // Apply print-friendly styles
  const styleEl = injectPdfStyles();
  element.classList.add(PDF_CLASS);

  // Add a report footer
  const jobId = fileName.replace('transcribebench-', '').slice(0, 8);
  const footer = addReportFooter(element, jobId);

  // Small delay to let browser reflow with new styles
  await new Promise((r) => setTimeout(r, 100));

  try {
    const canvas = await html2canvas(element, {
      backgroundColor,
      scale: 2,
      useCORS: true,
      logging: false,
      ignoreElements: (node) =>
        node instanceof HTMLElement && node.dataset.pdfIgnore === 'true',
    });

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const margin = 24; // pts margin on each side for a clean inset
    const contentWidth = pageWidth - margin * 2;
    const scale = contentWidth / canvas.width;
    const scaledFullHeight = canvas.height * scale;

    if (scaledFullHeight <= pageHeight - margin * 2) {
      const imgData = canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', margin, margin, contentWidth, scaledFullHeight);
      pdf.save(`${fileName}.pdf`);
      return;
    }

    // Multi-page with margins
    const usablePageHeight = pageHeight - margin * 2;
    const sliceHeightPx = Math.floor(usablePageHeight / scale);
    const totalPages = Math.ceil(canvas.height / sliceHeightPx);

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = sliceHeightPx;
    const sliceCtx = sliceCanvas.getContext('2d');
    if (!sliceCtx) throw new Error('Failed to obtain 2D context for PDF slicing.');

    for (let page = 0; page < totalPages; page += 1) {
      const sourceY = page * sliceHeightPx;
      const remaining = canvas.height - sourceY;
      const drawHeight = Math.min(sliceHeightPx, remaining);

      sliceCtx.fillStyle = backgroundColor;
      sliceCtx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
      sliceCtx.drawImage(
        canvas,
        0, sourceY, canvas.width, drawHeight,
        0, 0, canvas.width, drawHeight,
      );

      const sliceData = sliceCanvas.toDataURL('image/png');
      if (page > 0) pdf.addPage();
      pdf.addImage(sliceData, 'PNG', margin, margin, contentWidth, usablePageHeight);
    }

    pdf.save(`${fileName}.pdf`);
  } finally {
    // Clean up — restore dark UI
    element.classList.remove(PDF_CLASS);
    footer.remove();
    styleEl.remove();
  }
}
