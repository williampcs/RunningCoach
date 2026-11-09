/** 讀活動檔（FIT、GPX、TCX、zip），規格 12.40「讀 FIT 檔」 */
export { fileActivityId, hrZoneTimes, IMPORT_SPORTS, importRecordOf, rawOf, withHrZones, zoneBasisFor, type HrZoneBasis, type ImportRecord } from "./convert";
export { FitError, isFit, parseFit, typeOfFitSport, type ParseOptions } from "./fit";
export { parseGpx, parseTcx, XmlActivityError } from "./gpx";
export { scanFiles, type ScanInput, type ScanOptions, type ScanProblem, type ScanProgress, type ScanResult } from "./scan";
export type { ParsedActivity, ParsedLap } from "./types";
export { blobSource, bytesSource, isZip, ZipError, type RandomAccess } from "./zip";
export { importActivities, importSummaryText, previewImport, previewSummaryText, scanSummaryText, type ImportCounts, type ImportPreview } from "./import";
