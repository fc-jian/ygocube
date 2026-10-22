export interface ServerEvent {
  event: string;
  data: string;
}

/** SSE line framing accepts CRLF, CR and LF, including boundaries between chunks. */
export function createEventStreamParser(onEvent: (event: ServerEvent) => void) {
  let line = '';
  let event = '';
  let data: string[] = [];
  let skipLf = false;
  let firstCharacter = true;

  const consumeLine = () => {
    if (!line) {
      if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
      // State is recovered on every connection, so event IDs are not replayed.
    }
    line = '';
  };

  return (chunk: string) => {
    for (const char of chunk) {
      if (firstCharacter) {
        firstCharacter = false;
        if (char === '\uFEFF') continue;
      }
      if (skipLf) {
        skipLf = false;
        if (char === '\n') continue;
      }
      if (char === '\r' || char === '\n') {
        consumeLine();
        skipLf = char === '\r';
      } else {
        line += char;
      }
    }
  };
}

export async function readEventStream(response: Response, onEvent: (event: ServerEvent) => void): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    throw new Error('INVALID_EVENT_STREAM');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const consume = createEventStreamParser(onEvent);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    // An unterminated event is intentionally discarded, as required by SSE.
  } finally {
    reader.releaseLock();
  }
}
