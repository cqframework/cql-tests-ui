// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { Observable, defer, of, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import type { Bundle, Library, MeasureReport } from 'fhir/r4';
import {
  ElmToSqlTranspiler,
  generateMeasureReport as buildMeasureReport,
  inferMeasureUrlFromLibrary,
  normalizeMeasureReportForServer,
  sqlRowToPopulationCounts,
  type PopulationCounts,
} from '../../components/sql-on-fhir/elm-to-sql';
import {
  flattenBundle,
  type FlatRow,
  type FlatTables,
} from './sql-on-fhir-bundle-flattener.lib';
import { SqlOnFhirPgliteService } from './sql-on-fhir-pglite.service';
import { MeasureService } from '../measure.service';
import {
  measurementPeriodFromValues,
  type LibraryParameterValues,
} from '../../components/sql-on-fhir/library-parameters.lib';
import type { ExecutionSeedData } from './sql-on-fhir-execution-data.service';

export interface GenerateSqlResult {
  sql: string;
  populations: string[];
  warnings: string[];
}

export interface ExecuteSqlResult {
  raw: string;
  counts: PopulationCounts;
  durationMs: number;
}

@Injectable({ providedIn: 'root' })
export class SqlOnFhirPipelineService {
  private readonly pg = inject(SqlOnFhirPgliteService);
  private readonly measureService = inject(MeasureService);

  generateSql(
    elmJson: string,
    _library: Library | null,
    parameterValues: LibraryParameterValues = {},
  ): Observable<GenerateSqlResult> {
    return defer(() => {
      if (!elmJson || !elmJson.trim()) {
        return throwError(() => new Error('ELM JSON is empty — translation did not produce output.'));
      }
      try {
        const elm = JSON.parse(elmJson);
        const period = measurementPeriodFromValues(parameterValues);
        const transpiler = new ElmToSqlTranspiler({
          measurementPeriodStart: period.start,
          measurementPeriodEnd: period.end,
          parameterValues,
        });
        const { sql, populations, warnings } = transpiler.transpile(elm);
        return of<GenerateSqlResult>({ sql, populations, warnings: warnings ?? [] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return throwError(() => new Error(`SQL generation failed: ${msg}`));
      }
    });
  }

  executeSql(sql: string, seedData: ExecutionSeedData): Observable<ExecuteSqlResult> {
    return defer(async () => {
      const tables = mergeFlatTables(flattenBundle(seedData.bundle), {
        value_set_expansion: seedData.valueSetRows,
      });
      await this.pg.seed(seedData.dataKey, tables);
      const { rows, durationMs } = await this.pg.execute(sql);
      const firstRow = rows[0] ?? {};
      const counts = sqlRowToPopulationCounts(firstRow);
      return {
        raw: JSON.stringify(firstRow, null, 2),
        counts,
        durationMs,
      } satisfies ExecuteSqlResult;
    }).pipe(catchError(err => throwError(() => mapPgliteError(err))));
  }

  generateMeasureReport(
    counts: PopulationCounts,
    library: Library | null,
    parameterValues: LibraryParameterValues = {},
  ): Observable<MeasureReport> {
    return defer(() => {
      const period = measurementPeriodFromValues(parameterValues);
      const report = buildMeasureReport(counts, {
        measureUrl: inferMeasureUrlFromLibrary(library),
        periodStart: isoDate(period.start),
        periodEnd: isoDate(period.end),
        type: 'summary',
      });
      return of(report);
    });
  }

  saveMeasureReport(
    report: MeasureReport,
    persistedId?: string | null,
    persistedMeta?: MeasureReport['meta'] | null,
  ): Observable<MeasureReport> {
    const mode = persistedId?.trim() ? 'update' : 'create';
    const payload = normalizeMeasureReportForServer(report, mode, persistedId, persistedMeta);
    if (mode === 'update') {
      return this.measureService.putMeasureReport(payload);
    }
    return this.measureService.createMeasureReport(payload);
  }
}

function isoDate(s: string): string {
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function mergeFlatTables(a: FlatTables, b: Partial<FlatTables>): FlatTables {
  return {
    patient_view: a.patient_view,
    encounter_view: a.encounter_view,
    observation_view: a.observation_view,
    procedure_view: a.procedure_view,
    condition_view: a.condition_view,
    medication_request_view: a.medication_request_view,
    diagnostic_report_view: a.diagnostic_report_view,
    coverage_view: a.coverage_view,
    allergy_intolerance_view: a.allergy_intolerance_view,
    immunization_view: a.immunization_view,
    service_request_view: a.service_request_view,
    value_set_expansion: (b.value_set_expansion ?? []).concat(a.value_set_expansion),
  };
}

function mapPgliteError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}
