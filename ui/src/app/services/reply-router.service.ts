import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Injectable({ providedIn: 'root' })
export class ReplyRouterService {
  constructor(private http: HttpClient) {}

  async handleReply(opts: {
    companyId: string;
    category: string;
    threadId: string;
    subject: string;
    parentId?: string;
    timestamp?: string;
  }): Promise<void> {
    const cat = (opts.category || '').toLowerCase();
    if (cat === 'vlad') {
      const meAddress = await this.getMeAddress(opts.companyId);
      const tpl = await this.loadTemplate('emails/vlad-autoreply.md');
      const from = tpl.from || 'vlad@strtupify.io';
      const subject = tpl.subject || `Re: ${opts.subject || ''}`;
      const emailId = `vlad-auto-${Date.now()}`;
      const payload: any = {
        from,
        to: meAddress,
        subject,
        message: tpl.body,
        deleted: false,
        banner: tpl.banner ?? false,
        timestamp: opts.timestamp || new Date().toISOString(),
        threadId: opts.threadId,
        category: 'vlad',
      };
      if (opts.parentId) payload.parentId = opts.parentId;
      await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), payload);
      return;
    }
    if (cat === 'kickoff') {
      const meAddress = await this.getMeAddress(opts.companyId);
      const replyText = await this.getReplyBody(opts.companyId, opts.parentId || '');
      if (!replyText) return;
      const thread = await this.getThreadItems(opts.companyId, opts.threadId);
      const res = await this.http
        .post<any>('https://fa-strtupifyio.azurewebsites.net/api/kickoff_reply', {
          name: opts.companyId,
          threadId: opts.threadId,
          reply: replyText,
          thread,
        })
        .toPromise();
     const from = res && res.from ? res.from : 'noreply@strtupify.io';
     const subject = res && res.subject ? res.subject : `Re: ${opts.subject || ''}`;
     const body = res && res.body ? res.body : '';
      const status = res && res.status ? String(res.status).toLowerCase() : '';
      if (!body) return;
      const emailId = `kickoff-auto-${Date.now()}`;
      const payload: any = {
        from,
        to: meAddress,
        subject,
        message: body,
        deleted: false,
        banner: false,
        timestamp: opts.timestamp || new Date().toISOString(),
        threadId: opts.threadId,
        category: 'kickoff',
      };
      if (opts.parentId) payload.parentId = opts.parentId;
      await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), payload);
      if (status === 'approved') {
        try {
          await this.http
            .post<any>('https://fa-strtupifyio.azurewebsites.net/api/workitems', {
              company: opts.companyId,
            })
            .toPromise();
        } catch {}
      }
      return;
    }
  }

  async handleOutbound(opts: {
    companyId: string;
    to: string;
    subject: string;
    message: string;
    threadId: string;
    parentId: string;
    timestamp?: string;
  }): Promise<void> {
    const normalized = (opts.to || '').trim().toLowerCase();
    if (!normalized) return;
    if (normalized === 'vlad@strtupify.io') {
      await this.handleReply({
        companyId: opts.companyId,
        category: 'vlad',
        threadId: opts.threadId,
        subject: opts.subject,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
      });
      return;
    }
    await this.sendMailerDaemonBounce({
      companyId: opts.companyId,
      to: opts.to,
      subject: opts.subject,
      message: opts.message,
      threadId: opts.threadId,
      parentId: opts.parentId,
      timestamp: opts.timestamp,
    });
  }

  private async sendMailerDaemonBounce(opts: {
    companyId: string;
    to: string;
    subject: string;
    message: string;
    threadId: string;
    parentId: string;
    timestamp?: string;
  }): Promise<void> {
    const meAddress = await this.getMeAddress(opts.companyId);
    const { amountCents } =
      await this.incrementMailerDaemonCharge(opts.companyId);
    let subject = opts.subject
      ? `Undeliverable: ${opts.subject}`
      : 'Undeliverable: (no subject)';
    const amountDollars = (amountCents / 100).toFixed(2);

    const explanationLines = [
      `We're sorry, but your message to ${opts.to} could not be delivered because the address was not found.`,
      '',
      'Remote server responded: 550 5.1.1 Recipient address not found',
      'Please check for typos or confirm the recipient actually works here.',
      '',
      `A manual directory lookup fee of $${amountDollars} has been charged to your Startupify account.`,
    ];

    explanationLines.push(
      '',
      'Why the charge? Vlad insists each failed delivery triggers a manual diagnostic where he lovingly glares at the mail server. Apparently that is billable time.',
      '',
      "No further action is required. Your original message has been quarantined for 48 hours before being recycled into training data for Vlad's clock project.",
      '',
      '-- mailer-daemon@strtupify.io'
    );

    const fallbackBody = explanationLines.join('\n');

    const templateContext: Record<string, string> = {
      SUBJECT: subject,
      TO: opts.to,
      AMOUNT_DOLLARS: amountDollars,
    };

    let from = 'mailer-daemon@strtupify.io';
    let banner = false;
    let deleted = false;
    let body = fallbackBody;

    try {
      const template = await this.loadTemplate('emails/mailer-daemon.md');
      const rendered = this.renderTemplate(template, templateContext);
      if (rendered.from) from = rendered.from;
      if (rendered.subject) subject = rendered.subject;
      if (typeof rendered.banner === 'boolean') banner = rendered.banner;
      if (typeof rendered.deleted === 'boolean') deleted = rendered.deleted;
      if (rendered.body) body = rendered.body;
    } catch {}

    const emailId = `mailer-daemon-${Date.now()}`;
    const payload: any = {
      from,
      to: meAddress,
      subject,
      message: body,
      deleted,
      banner,
      timestamp: opts.timestamp || new Date().toISOString(),
      threadId: opts.threadId,
      category: 'mailer-daemon',
    };
    if (opts.parentId) {
      payload.parentId = opts.parentId;
    }
    await setDoc(
      doc(db, `companies/${opts.companyId}/inbox/${emailId}`),
      payload
    );
  }

  private async incrementMailerDaemonCharge(
    companyId: string
  ): Promise<{ amountCents: number; multiplier: number; previousCents: number }> {
    try {
      const ref = doc(db, `companies/${companyId}`);
      const snap = await getDoc(ref);
      const data = snap.exists() ? ((snap.data() as any) || {}) : {};
      const previous =
        typeof data.mailerDaemonChargeCents === 'number'
          ? Math.max(0, Math.round(data.mailerDaemonChargeCents))
          : 0;
      let multiplier = 1;
      let next = 5;
      if (previous > 0) {
        multiplier = this.randomInt(2, 10);
        next = Math.max(1, Math.round(previous * multiplier));
      }
      await setDoc(
        ref,
        {
          mailerDaemonChargeCents: next,
          mailerDaemonChargeMultiplier: multiplier,
          mailerDaemonChargeUpdatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      return { amountCents: next, multiplier, previousCents: previous };
    } catch {
      return { amountCents: 5, multiplier: 1, previousCents: 0 };
    }
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private async getReplyBody(companyId: string, replyId: string): Promise<string> {
    try {
      if (!replyId) return '';
      const snap = await getDoc(doc(db, `companies/${companyId}/inbox/${replyId}`));
      const data = snap.data() as any;
      return data && data.message ? String(data.message) : '';
    } catch {
      return '';
    }
  }

  private async getThreadItems(companyId: string, threadId: string): Promise<any[]> {
    try {
      const inboxRef = collection(db, `companies/${companyId}/inbox`);
      const q = query(inboxRef, where('threadId', '==', threadId));
      const snap = await getDocs(q);
      const items = snap.docs.map((d) => {
        const x = d.data() as any;
        return {
          id: d.id,
          from: x.from || '',
          to: x.to || '',
          subject: x.subject || '',
          message: x.message || '',
          timestamp: x.timestamp || '',
          parentId: x.parentId || '',
        };
      });
      items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return items;
    } catch {
      return [];
    }
  }

  private async getMeAddress(companyId: string): Promise<string> {
    try {
      const snap = await getDoc(doc(db, `companies/${companyId}`));
      let domain = `${companyId}.com`;
      if (snap.exists()) {
        const data = snap.data() as any;
        if (data && data.company_name) {
          domain = String(data.company_name).replace(/\s+/g, '').toLowerCase() + '.com';
        }
      }
      return `me@${domain}`;
    } catch {
      return `me@${companyId}.com`;
    }
  }

  private loadTemplate(path: string): Promise<{ from?: string; subject?: string; banner?: boolean; deleted?: boolean; body: string }>
  {
    return new Promise((resolve, reject) => {
      this.http.get(path, { responseType: 'text' }).subscribe({
        next: (text) => {
          const parsed = this.parseMarkdownEmail(text);
          resolve(parsed);
        },
        error: (err) => reject(err),
      });
    });
  }

  private renderTemplate(
    template: { from?: string; subject?: string; banner?: boolean; deleted?: boolean; body: string },
    context: Record<string, string>
  ): { from?: string; subject?: string; banner?: boolean; deleted?: boolean; body: string } {
    const replacePlaceholders = (value?: string): string | undefined => {
      if (typeof value !== 'string') return value;
      return value.replace(/\[\[\s*([A-Za-z0-9_]+)\s*\]\]/g, (_: string, key: string) => {
        const normalized = key.trim().toUpperCase();
        return context[normalized] ?? '';
      });
    };
    return {
      from: replacePlaceholders(template.from),
      subject: replacePlaceholders(template.subject),
      banner: template.banner,
      deleted: template.deleted,
      body: replacePlaceholders(template.body) || '',
    };
  }

  private parseMarkdownEmail(text: string): {
    from?: string;
    subject?: string;
    banner?: boolean;
    deleted?: boolean;
    body: string;
  } {
    const lines = text.split(/\r?\n/);
    let i = 0;
    const meta: any = {};
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i++;
        break;
      }
      const idx = line.indexOf(':');
      if (idx > -1) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === 'from') meta.from = value;
        else if (key === 'subject') meta.subject = value;
        else if (key === 'banner') meta.banner = /^true$/i.test(value);
        else if (key === 'deleted') meta.deleted = /^true$/i.test(value);
      } else {
        break;
      }
      i++;
    }
    const body = lines.slice(i).join('\n').trim();
    return { ...meta, body };
  }
}
