import { Component, EventEmitter, Input, OnChanges, Output, inject } from '@angular/core';
import { ContractAgreement, ContractNegotiation } from '@think-it-labs/edc-connector-client';
import { ContractAndTransferService } from '../contract-and-transfer.service';
import * as mime from 'mime';
import { DatasetPreviewComponent } from '../dataset-preview/dataset-preview.component';

@Component({
  selector: 'lib-transfer-pull-download',
  templateUrl: './transfer-pull-download.component.html',
  imports: [DatasetPreviewComponent],
})
export class TransferPullDownloadComponent implements OnChanges {
  private readonly transferService = inject(ContractAndTransferService);

  private readonly EXTENSION_WARNING =
    "Override the filename or when the download includes a content type this may trigger your browser to set a file extension. Otherwise, the download won't have a file extension.";

  @Input() agreement!: ContractAgreement;
  @Input() negotiation!: ContractNegotiation;
  @Input() transferId!: string;
  @Output() startEvent = new EventEmitter<void>();
  @Output() completionEvent = new EventEmitter<void>();
  @Output() errorEvent = new EventEmitter<string>();

  warningMsg?: string;
  fileExtension?: string | null = null;
  showPreview = false;

  async ngOnChanges() {
    if (this.negotiation && this.agreement) {
      const dataset = await this.transferService.getDataset(this.agreement, this.negotiation, true);
      if (!dataset) {
        this.errorEvent.emit('Could not fetch the dataset for this contract agreement.');
        return;
      }
      if (dataset['contenttype']) {
        this.fileExtension = mime.default.getExtension(dataset['contenttype']);
        if (!this.fileExtension) {
          this.warningMsg = `The content type of the asset set is '${dataset['contenttype']}', but no file extension was found for this type. ${this.EXTENSION_WARNING}`;
        } else {
          this.fileExtension = '.' + this.fileExtension;
        }
      } else {
        this.warningMsg = `No content type for the asset set. ${this.EXTENSION_WARNING}`;
      }
    }
  }

  openPreview(): void {
    this.startEvent.emit();
    this.showPreview = true;
  }
}
