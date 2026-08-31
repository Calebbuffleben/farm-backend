/**
 * Subconjunto do payload de webhook da WhatsApp Cloud API (formato que o
 * 360dialog repassa). Campos fora deste shape são ignorados.
 */

export interface CloudApiWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: CloudApiChangeValue;
    }>;
  }>;
}

export interface CloudApiChangeValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    wa_id?: string;
    profile?: { name?: string };
  }>;
  messages?: CloudApiMessage[];
  statuses?: Array<{ id?: string; status?: string }>;
}

export interface CloudApiMedia {
  id?: string;
  mime_type?: string;
  sha256?: string;
  /** URL de download direta (CDN da Meta) — presente nos webhooks do 360dialog */
  url?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface CloudApiMessage {
  id?: string; // wamid
  from?: string; // telefone do produtor (sem +)
  timestamp?: string; // epoch seconds
  type?: string; // text | audio | image | document | ...
  text?: { body?: string };
  audio?: CloudApiMedia;
  image?: CloudApiMedia;
  document?: CloudApiMedia;
}
