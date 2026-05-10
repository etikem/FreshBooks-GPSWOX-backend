import { prisma } from '../db/prisma';
import type { Client } from '@prisma/client';
import {ensureClientFromFreshbooks} from './webhook.service';
/**
 * Maps a FreshBooks client identifier (or e-mail) to our internal Client
 * record. If we don't recognise the identifier, we return null and the
 * caller logs the webhook but does NOT touch ABC Track — better to drop a
 * legitimate event than enable access for an unknown account.
 */
export class ClientMappingService {
  async findByFreshbooksClientId(
    freshbooksClientId: string,
  ): Promise<Client | null> {
    return ensureClientFromFreshbooks(freshbooksClientId);
  }


  async findByEmail(email: string): Promise<Client | null> {
    return prisma.client.findFirst({
      where: { email: email.trim().toLowerCase() },
    });
  }

  /**
   * Best-effort identification from a webhook payload. The order matters:
   * trust the explicit FreshBooks id over an email match.
   */
  async identifyFromPayload(payload: {
    freshbooksClientId?: string | null;
    email?: string | null;
  }): Promise<Client | null> {
    if (payload.freshbooksClientId) {
      const c = await this.findByFreshbooksClientId(payload.freshbooksClientId);
      console.log('c========>', c)
      if (c) return c;
    }
    if (payload.email) {
      console.log('Attempting email lookup for', payload.email);
      return this.findByEmail(payload.email);
    }
    return null;
  }
}

export const clientMappingService = new ClientMappingService();
