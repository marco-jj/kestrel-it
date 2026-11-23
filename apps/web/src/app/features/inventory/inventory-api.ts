import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  DatatableResponse,
  SelectlistResponse,
  StandardApiResponse,
} from '@kestrel-it/shared';
import { firstValueFrom } from 'rxjs';
import type { DataGridRow } from '../../shared/ui/data-grid.component.js';

export function inventoryError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const message: unknown = error.error?.messages ?? error.error?.message;
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') {
      const messages = Object.values(message)
        .flat()
        .filter((item) => typeof item === 'string');
      if (messages.length) return messages.join(' ');
    }
  }
  return 'The operation could not be completed.';
}

@Injectable({ providedIn: 'root' })
export class InventoryApi {
  private readonly http = inject(HttpClient);
  private readonly prefix = '/api/v1';

  read<T>(path: string, query: Record<string, string | number | boolean> = {}) {
    return firstValueFrom(
      this.http.get<T>(this.prefix + path, {
        params: new HttpParams({ fromObject: query }),
      }),
    );
  }

  records(path: string, query: Record<string, string | number | boolean> = {}) {
    return this.read<DatatableResponse<DataGridRow>>(path, query);
  }

  options(resource: string, search: string, page = 1) {
    return this.read<SelectlistResponse>(`/${resource}/selectlist`, { search, page });
  }

  write<T>(method: 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown) {
    return firstValueFrom(
      this.http.request<StandardApiResponse<T>>(method, this.prefix + path, { body }),
    );
  }

  blob(path: string) {
    return firstValueFrom(this.http.get(this.prefix + path, { responseType: 'blob' }));
  }
}
