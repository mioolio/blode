export class DOMParser {
  constructor(options?: {
    errorHandler?: { warning?: () => void; error?: () => void; fatalError?: () => void };
  });
  parseFromString(source: string, type: string): Document;
}
