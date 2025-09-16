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
