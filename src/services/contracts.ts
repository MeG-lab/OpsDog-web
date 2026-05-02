export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

export interface ModelListRequest {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}
