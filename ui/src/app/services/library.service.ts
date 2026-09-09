// Author: Preston Lee

import { Injectable, inject, signal } from '@angular/core';
import { BaseService } from './base.service';
import { Library, Parameters, Bundle } from 'fhir/r4';
import { decodeUtf8Base64 } from './utf8-encoding.lib';
import { Observable, of, throwError } from 'rxjs';
import { map, catchError, tap } from 'rxjs/operators';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { SettingsService } from './settings.service';
import { buildHttpHeaders } from './endpoint-config.lib';
import { appendEvaluateEndpointParameters } from './cql-evaluate-parameters.lib';

@Injectable({
	providedIn: 'root'
})
export class LibraryService extends BaseService {

  readonly deletedLibraryIds = signal<ReadonlySet<string>>(new Set());

	public static readonly LIBRARY_PATH = '/Library';

	public libraryId: string = '';

	protected settingsService = inject(SettingsService);

	private evaluationHeaders(): HttpHeaders {
		const ctx = this.settingsService.getEndpointHttpContext('evaluation', {
			'Content-Type': 'application/fhir+json',
			Accept: 'application/fhir+json'
		});
		return buildHttpHeaders(
			{ ...this.settingsService.getActiveEnvironment().evaluationServer, address: ctx.address },
			ctx.headers
		);
	}

	private contentHeaders(): HttpHeaders {
		const ctx = this.settingsService.getEndpointHttpContext('content', {
			'Content-Type': 'application/fhir+json',
			Accept: 'application/fhir+json'
		});
		return buildHttpHeaders(
			{ ...this.settingsService.getActiveEnvironment().contentEndpoint, address: ctx.address },
			ctx.headers
		);
	}

	private evaluationBaseUrl(): string {
		return this.settingsService.getEffectiveEvaluationServerUrl();
	}

	private contentBaseUrl(): string {
		return this.settingsService.getEffectiveContentEndpointAddress();
	}

	public order: 'asc' | 'desc' = 'asc';
	public pageSize = 10;
	public offset = 0;

	url(): string {
		return this.evaluationBaseUrl() + LibraryService.LIBRARY_PATH;
	}

	contentUrl(): string {
		return this.contentBaseUrl() + LibraryService.LIBRARY_PATH;
	}

	search(searchTerm: string): Observable<Bundle> {
		return this.http.get<Bundle>(this.url() + "?title:contains=" + searchTerm, { headers: this.evaluationHeaders() });
	}

	// Search libraries with pagination and sorting
	// Uses title:contains for searching (searches the human-friendly title field)
	searchPaginated(searchTerm: string, page: number = 1, pageSize: number = 10, sortBy: string = 'name', order: 'asc' | 'desc' = 'asc'): Observable<Bundle> {
		const offset = (page - 1) * pageSize;
		let url = this.url() + `?_count=${pageSize}&_offset=${offset}`;
		
		// Add search parameter - search on title field
		const encodedTerm = encodeURIComponent(searchTerm);
		url += `&title:contains=${encodedTerm}`;
		
		// Add sorting parameters
		if (sortBy === 'name') {
			url += `&_sort=${order === 'asc' ? 'name' : '-name'}`;
		} else if (sortBy === 'version') {
			url += `&_sort=${order === 'asc' ? 'version' : '-version'}`;
		} else if (sortBy === 'date') {
			url += `&_sort=${order === 'asc' ? 'date' : '-date'}`;
		}
		
		return this.http.get<Bundle>(url, { headers: this.evaluationHeaders() });
	}

	// Get paginated list of all libraries
	getAll(page: number = 1, pageSize: number = 10, sortBy: string = 'name', order: 'asc' | 'desc' = 'asc'): Observable<Bundle> {
		const offset = (page - 1) * pageSize;
		let url = this.url() + `?_count=${pageSize}&_offset=${offset}`;
		
		// Add sorting parameters
		if (sortBy === 'name') {
			url += `&_sort=${order === 'asc' ? 'name' : '-name'}`;
		} else if (sortBy === 'version') {
			url += `&_sort=${order === 'asc' ? 'version' : '-version'}`;
		} else if (sortBy === 'date') {
			url += `&_sort=${order === 'asc' ? 'date' : '-date'}`;
		}
		
		return this.http.get<Bundle>(url, { headers: this.evaluationHeaders() });
	}

	urlFor(id: string) {
		return this.evaluationBaseUrl() + '/Library/' + id;
	}

	get(id: string) {
		return this.http.get<Library>(this.urlFor(id), { headers: this.evaluationHeaders() });
	}

	findByNameAndVersion(name: string, version?: string, useContentEndpoint = false): Observable<Library | null> {
		const base = useContentEndpoint ? this.contentUrl() : this.url();
		let url = base + `?name=${encodeURIComponent(name)}&_count=1`;
		if (version) {
			url += `&version=${encodeURIComponent(version)}`;
		}
		return this.http.get<Bundle>(url, { headers: useContentEndpoint ? this.contentHeaders() : this.evaluationHeaders() }).pipe(
			map(bundle => {
				const entry = bundle.entry?.[0]?.resource;
				return entry?.resourceType === 'Library' ? entry as Library : null;
			}),
			catchError(() => of(null))
		);
	}

	getElmXml(library: Library): Observable<string> {
		const content = library.content?.find(c => c.contentType === 'application/elm+xml');
		if (!content) {
			return of('');
		}
		if (content.data) {
			try {
				return of(decodeUtf8Base64(content.data));
			} catch {
				return of('');
			}
		}
		if (content.url) {
			const headers = new HttpHeaders({ 'Accept': 'application/xml, text/xml' });
			return this.http.get(content.url, { headers, responseType: 'text' }).pipe(
				catchError(() => of(''))
			);
		}
		return of('');
	}

	getCqlContent(library: Library): Observable<{ cqlContent: string; fromUrl: boolean }> {
		const content = library.content?.find(c => c.contentType === 'text/cql');
		if (!content) {
			return of({ cqlContent: '', fromUrl: false });
		}
		if (content.data) {
			try {
				const cqlContent = decodeUtf8Base64(content.data);
				return of({ cqlContent, fromUrl: false });
			} catch {
				return of({ cqlContent: '', fromUrl: false });
			}
		}
		if (content.url) {
			const headers = new HttpHeaders({ 'Accept': 'text/plain, text/cql' });
			return this.http.get(content.url, { headers, responseType: 'text' }).pipe(
				map(body => ({ cqlContent: body, fromUrl: true })),
				catchError(err => {
					const message = err?.message ?? err?.statusText ?? String(err);
					const status = err?.status;
					return throwError(() => new Error(status ? `HTTP ${status}: ${message}` : message));
				})
			);
		}
		return of({ cqlContent: '', fromUrl: false });
	}

	getExampleCql(url: string) {
		let headers = new HttpHeaders({ 'Accept': 'text/plain' });
		return this.http.get<string>(url, { headers: headers, responseType: 'text' as 'json' });
	}

	post(Library: Library) {
		return this.http.post<Library>(this.url(), JSON.stringify(Library), { headers: this.evaluationHeaders() });
	}

	put(Library: Library) {
		return this.http.put<Library>(this.urlFor(Library.id!), JSON.stringify(Library), { headers: this.evaluationHeaders() });
	}

	delete(Library: Library) {
		return this.http.delete<Library>(this.urlFor(Library.id!), { headers: this.evaluationHeaders() }).pipe(tap(() => {
      this.deletedLibraryIds.update(ids => new Set(ids).add(Library.id!));
    }));
	}

    evaluate(libraryId: string, parameters: Parameters) {
		appendEvaluateEndpointParameters(parameters, this.settingsService.getActiveEnvironment());
        return this.http.post<Parameters>(
			this.urlFor(libraryId) + '/$evaluate',
			JSON.stringify(parameters),
			{ headers: this.evaluationHeaders() }
		);
    }
}
