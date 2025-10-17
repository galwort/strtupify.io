import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  collection,
  query,
  where,
  limit,
  serverTimestamp,
} from 'firebase/firestore';
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
    if (cat === 'workitem-help') {
      if (!opts.parentId) return;
      const replyText = await this.getReplyBody(opts.companyId, opts.parentId);
      if (!replyText) return;

      const parentSnap = await getDoc(doc(db, `companies/${opts.companyId}/inbox/${opts.parentId}`));
      if (!parentSnap.exists()) return;
      const parent = (parentSnap.data() as any) || {};
      const workitemId = String(parent.workitemId || parent.workitem_id || '').trim();
      if (!workitemId) return;

      const product = await this.getAcceptedProduct(opts.companyId, parent);
      const workitemCtx = await this.getWorkitemContext(opts.companyId, workitemId, parent);
      const workerName = String(parent.senderName || parent.workerName || workitemCtx.assigneeName || 'Teammate');
      const workerTitle = String(parent.senderTitle || parent.workerTitle || workitemCtx.assigneeTitle || 'Contributor');
      const thread = await this.getThreadItems(opts.companyId, opts.threadId);

      const reviewPayload = {
        company: opts.companyId,
        product,
        workitem: {
          id: workitemId,
          title: workitemCtx.title,
          description: workitemCtx.description,
          category: workitemCtx.category,
        },
        worker: {
          name: workerName,
          title: workerTitle,
        },
        email: {
          subject: String(parent.subject || workitemCtx.subject || `Need input: ${workitemCtx.title}`),
          body: String(parent.message || workitemCtx.body || ''),
          question: String(parent.assistQuestion || parent.question || ''),
          pause_reason: String(parent.assistPauseReason || workitemCtx.pauseReason || ''),
          tone: String(parent.assistTone || ''),
        },
        reply: {
          text: replyText,
          thread,
        },
      };

      let review: any = null;
      try {
        review = await this.http
          .post('https://fa-strtupifyio.azurewebsites.net/api/workitem_assist_review', reviewPayload)
          .toPromise();
      } catch (err) {
        console.error('assist review failed', err);
      }
      if (!review || !review.ok) return;

      const multiplier = Number(review.multiplier);
      if (!Number.isFinite(multiplier) || multiplier <= 0) return;
      const helpfulness = String(review.helpfulness || '');
      const reasoning = String(review.reasoning || '');
      const followUp = (review.follow_up || {}) as any;
      const confidence = Number(review.confidence);
      const improvements = Array.isArray(review.improvements)
        ? (review.improvements as any[]).filter((x) => typeof x === 'string')
        : [];

      const workitemRef = doc(db, `companies/${opts.companyId}/workitems/${workitemId}`);
      const workitemSnap = await getDoc(workitemRef);
      const workitemData = (workitemSnap.data() as any) || {};
      const baseRateRaw = Number(workitemData.rate_per_hour || 1);
      const assignedRateRaw = Number(
        (workitemData.llm_rates && workitemData.llm_rates.assigned_rate) || baseRateRaw
      );
      const baseRate = Number.isFinite(assignedRateRaw) && assignedRateRaw > 0 ? assignedRateRaw : Math.max(baseRateRaw, 0.1);
      let nextRate = baseRate * multiplier;
      if (!Number.isFinite(nextRate) || nextRate <= 0) nextRate = baseRate;
      nextRate = Math.max(0.1, Math.min(5, Math.round(nextRate * 10000) / 10000));
      const estimatedHours = Math.max(1, Math.round(100 / nextRate));
      const simTime = await this.getCompanySimTime(opts.companyId);

      const updatePayload: Record<string, any> = {
        assist_status: 'resolved',
        assist_multiplier: multiplier,
        assist_last_multiplier: multiplier,
        assist_resolved_at: simTime,
        assist_helpfulness: helpfulness,
        assist_reasoning: reasoning,
        assist_improvements: improvements,
        rate_per_hour: nextRate,
        estimated_hours: estimatedHours,
        started_at: simTime,
        updated: serverTimestamp(),
        'llm_rates.assigned_rate': nextRate,
        'llm_rates.updated': serverTimestamp(),
      };
      if (workitemCtx.assigneeId) {
        updatePayload['llm_rates.assigned_employee_id'] = workitemCtx.assigneeId;
        updatePayload[`llm_rates.rates.${workitemCtx.assigneeId}`] = nextRate;
      }
      if (Number.isFinite(confidence)) updatePayload['assist_confidence'] = confidence;

      await updateDoc(workitemRef, updatePayload);

      const evaluationStamp = new Date(simTime).toISOString();
      await setDoc(
        doc(db, `companies/${opts.companyId}/inbox/${opts.parentId}`),
        {
          assistMultiplier: multiplier,
          assistHelpfulness: helpfulness,
          assistReasoning: reasoning,
          assistConfidence: Number.isFinite(confidence) ? confidence : null,
          assistImprovements: improvements,
          assistEvaluatedAt: evaluationStamp,
        },
        { merge: true }
      );

      const followBody = typeof followUp.body === 'string' ? followUp.body : '';
      if (followBody.trim().length) {
        const followSubject = typeof followUp.subject === 'string' && followUp.subject
          ? followUp.subject
          : `Re: ${opts.subject || parent.subject || workitemCtx.title}`;
        const followId = `assist-follow-${Date.now()}`;
        await setDoc(doc(db, `companies/${opts.companyId}/inbox/${followId}`), {
          from: parent.from || this.buildWorkerAddress(workerName, opts.companyId),
          to: parent.to || (await this.getMeAddress(opts.companyId)),
          subject: followSubject,
          message: followBody,
          deleted: false,
          banner: false,
          timestamp: evaluationStamp,
          threadId: opts.threadId,
          parentId: opts.parentId,
          category: 'workitem-help',
          workitemId,
          assistId: parent.assistId || parent.assist_id || opts.threadId,
          assistMultiplier: multiplier,
          assistHelpfulness: helpfulness,
        });
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

  private async getAcceptedProduct(
    companyId: string,
    parent: any
  ): Promise<{ name: string; description: string }> {
    const fromParentName =
      (parent && (parent.productName || parent.assistProductName || parent.assist_product_name)) || '';
    const fromParentDescription =
      (parent && (parent.productDescription || parent.assistProductDescription || parent.assist_product_description)) || '';
    const name = String(fromParentName || '').trim();
    const description = String(fromParentDescription || '').trim();
    if (name && description) {
      return { name, description };
    }
    try {
      const productsRef = collection(db, `companies/${companyId}/products`);
      const snap = await getDocs(query(productsRef, where('accepted', '==', true), limit(1)));
      if (!snap.empty) {
        const data = (snap.docs[0].data() as any) || {};
        const prodName = String(data.product || data.name || '').trim();
        const prodDescription = String(data.description || '').trim();
        if (prodName || prodDescription) {
          return {
            name: prodName || name || 'Product',
            description: prodDescription || description || '',
          };
        }
      }
    } catch (err) {
      console.error('failed to load accepted product', err);
    }
    return {
      name: name || 'Product',
      description: description,
    };
  }

  private async getWorkitemContext(
    companyId: string,
    workitemId: string,
    parent: any
  ): Promise<{
    title: string;
    description: string;
    category: string;
    assigneeId?: string;
    assigneeName?: string;
    assigneeTitle?: string;
    subject?: string;
    body?: string;
    pauseReason?: string;
  }> {
    try {
      const ref = doc(db, `companies/${companyId}/workitems/${workitemId}`);
      const snap = await getDoc(ref);
      const data = (snap.data() as any) || {};
      return {
        title: String(parent.assistWorkitemTitle || parent.assist_workitem_title || data.title || `Work Item ${workitemId}`),
        description: String(
          parent.assistWorkitemDescription ||
            parent.assist_workitem_description ||
            data.description ||
            ''
        ),
        category: String(data.category || ''),
        assigneeId: data.assignee_id ? String(data.assignee_id) : undefined,
        assigneeName: parent.senderName || parent.workerName || data.assignee_name || undefined,
        assigneeTitle: parent.senderTitle || parent.workerTitle || data.assignee_title || undefined,
        subject: String(parent.subject || data.subject || ''),
        body: String(parent.message || ''),
        pauseReason: String(parent.assistPauseReason || data.assist_pause_reason || ''),
      };
    } catch (err) {
      console.error('failed to load workitem context', err);
      return {
        title: String(parent.assistWorkitemTitle || `Work Item ${workitemId}`),
        description: String(parent.assistWorkitemDescription || ''),
        category: '',
        assigneeId: undefined,
        assigneeName: parent.senderName || undefined,
        assigneeTitle: parent.senderTitle || undefined,
        subject: String(parent.subject || ''),
        body: String(parent.message || ''),
        pauseReason: String(parent.assistPauseReason || ''),
      };
    }
  }

  private async getCompanySimTime(companyId: string): Promise<number> {
    try {
      const snap = await getDoc(doc(db, `companies/${companyId}`));
      const data = (snap.data() as any) || {};
      const value = Number(data.simTime || Date.now());
      return Number.isFinite(value) && value > 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private buildWorkerAddress(name: string, companyId: string): string {
    const normalized = (name || 'teammate').toLowerCase().replace(/[^a-z0-9]+/g, '.');
    const local = normalized.replace(/^\.+|\.+$/g, '') || 'teammate';
    const domain = `${companyId.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'strtupify'}.com`;
    return `${local}@${domain}`;
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
