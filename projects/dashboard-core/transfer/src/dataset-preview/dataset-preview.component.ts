import { Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ContractAgreement } from '@think-it-labs/edc-connector-client';
import { DashboardStateService } from '@eclipse-edc/dashboard-core';

@Component({
  selector: 'lib-dataset-preview',
  templateUrl: './dataset-preview.component.html',
  imports: [FormsModule],
})
export class DatasetPreviewComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly stateService = inject(DashboardStateService);

  @Input() transferId!: string;
  @Input() agreement!: ContractAgreement;
  @Input() fileExtension?: string | null;
  @Output() downloadEvent = new EventEmitter<void>();

  loading = true;
  error?: string;
  previewLines?: string[];
  blob?: Blob;
  filename?: string;

  get defaultFilename(): string {
    return (this.agreement?.assetId ?? 'dataset') + (this.fileExtension ?? '');
  }

  async ngOnInit() {
    const connectorId = this.stateService.currentConnectorId;
    if (!connectorId) {
      this.error = 'Cannot determine connector ID. Make sure the connector is configured via the server.';
      this.loading = false;
      return;
    }

    try {
      this.blob = await firstValueFrom(
        this.http.get(`/api/${connectorId}/transfers/${encodeURIComponent(this.transferId)}/download`, {
          responseType: 'blob',
        }),
      );
      const text = await this.blob.text();
      try {
        this.previewLines = JSON.stringify(JSON.parse(text), null, 2).split('\n');
      } catch {
        this.previewLines = text.split('\n');
      }
    } catch (err) {
      this.error = `Failed to load preview: ${(err as Error).message}`;
    } finally {
      this.loading = false;
    }
  }

  download(): void {
    if (!this.blob) return;
    const url = URL.createObjectURL(this.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.filename?.trim() || this.defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.downloadEvent.emit();
  }
}
