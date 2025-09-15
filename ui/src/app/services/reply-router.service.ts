import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';
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
    if (cat !== 'vlad') return;
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
