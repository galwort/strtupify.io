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
  runTransaction,
} from 'firebase/firestore';
import { environment } from 'src/environments/environment';

const fbApp = getApps().length ? getApps()[0] : initializeApp(environment.firebase);
const db = getFirestore(fbApp);

@Injectable({ providedIn: 'root' })
export class ReplyRouterService {
  constructor(private http: HttpClient) {}

  private readonly kickoffLeadMs = 5 * 60_000; // mirror the kickoff send lead time
  private readonly historyDivider = '----- Previous messages -----';
  private readonly historyRegex =
    /-----\s*(previous (?:messages?|emails?|repl(?:y|ies))|original (?:message|email))\s*-----/i;
  private readonly workdayStartHour = 8;
  private readonly workdayEndHour = 17;

  async handleReply(opts: {
    companyId: string;
    category: string;
    threadId: string;
    subject: string;
    parentId?: string;
    timestamp?: string;
  }): Promise<void> {
    const cat = (opts.category || '').toLowerCase();
    const threadItems = await this.getThreadItems(opts.companyId, opts.threadId);
    if (cat === 'vlad') {
      const meAddress = await this.getMeAddress(opts.companyId);
      const tpl = await this.loadTemplate('emails/vlad-autoreply.md');
      const from = tpl.from || 'vlad@strtupify.io';
      const subject = opts.subject || tpl.subject || '(no subject)';
      const message = await this.appendThreadHistory({
        companyId: opts.companyId,
        threadId: opts.threadId,
        body: tpl.body,
        threadItems,
      });
      const emailId = `vlad-auto-${Date.now()}`;
      const payload: any = {
        from,
        to: meAddress,
        subject,
        message,
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
    if (cat === 'mom') {
      const replyText = await this.getReplyBody(opts.companyId, opts.parentId || '');
      await this.handleMomConversation({
        companyId: opts.companyId,
        subject: opts.subject,
        message: replyText,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
        threadItems,
      });
      return;
    }
    if (cat === 'cadabra') {
      const replyText = await this.getReplyBody(opts.companyId, opts.parentId || '');
      await this.handleCadabraConversation({
        companyId: opts.companyId,
        subject: opts.subject,
        message: replyText,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
        threadItems,
      });
      return;
    }
    if (cat === 'supereats') {
      const replyText = await this.getReplyBody(opts.companyId, opts.parentId || '');
      await this.handleSupereatsConversation({
        companyId: opts.companyId,
        subject: opts.subject,
        message: replyText,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
        threadItems,
      });
      return;
    }
    if (cat === 'bank') {
      await this.sendBankAutoReply({
        companyId: opts.companyId,
        subject: opts.subject,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
        threadItems,
      });
      return;
    }
    if (cat === 'kickoff') {
      const meAddress = await this.getMeAddress(opts.companyId);
      const replyDoc = await this.getReplyDoc(opts.companyId, opts.parentId);
      const replyText =
        (replyDoc && typeof replyDoc.message === 'string' && replyDoc.message) ||
        (await this.getReplyBody(opts.companyId, opts.parentId || ''));
      if (!replyText) return;

      const kickoffComplete = await this.kickoffLoopFinished(opts.companyId);
      if (kickoffComplete) {
        const recipientRaw =
          (replyDoc && typeof replyDoc.to === 'string' && replyDoc.to) || '';
        const recipient = this.normalizeAddress(recipientRaw);
        const employee = recipient
          ? await this.matchEmployeeRecipient(opts.companyId, recipient)
          : null;
        if (employee) {
          await this.handleEmployeeEmail({
            companyId: opts.companyId,
            to: recipient || recipientRaw,
            subject: opts.subject,
            message: replyText,
            threadId: opts.threadId,
            parentId: opts.parentId,
            timestamp: opts.timestamp,
            employee,
          });
          return;
        }
      }

      const res = await this.http
        .post<any>('https://fa-strtupifyio.azurewebsites.net/api/kickoff_reply', {
          name: opts.companyId,
          threadId: opts.threadId,
          reply: replyText,
          thread: threadItems,
        })
        .toPromise();
      const from = res && res.from ? res.from : 'noreply@strtupify.io';
      const subject = opts.subject || (res && res.subject ? res.subject : '(no subject)');
      let body = res && res.body ? res.body : '';
      const status = res && res.status ? String(res.status).toLowerCase() : '';
      if (!body) return;
      body = await this.appendThreadHistory({
        companyId: opts.companyId,
        threadId: opts.threadId,
        body,
        threadItems,
      });
      const emailId = `kickoff-auto-${Date.now()}`;
      const simNow = await this.getCompanySimTime(opts.companyId);
      const baseTs = opts.timestamp ? new Date(opts.timestamp) : null;
      const baseMs = baseTs && baseTs.toString() !== 'Invalid Date' ? baseTs.getTime() : Number.NaN;
      const kickoffTimestamp = new Date(Math.max(simNow, Number.isFinite(baseMs) ? baseMs + 1 : simNow)).toISOString();
      const payload: any = {
        from,
        to: meAddress,
        subject,
        message: body,
        deleted: false,
        banner: false,
        timestamp: kickoffTimestamp,
        threadId: opts.threadId,
        category: 'kickoff',
      };
      if (opts.parentId) payload.parentId = opts.parentId;
      await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), payload);
      await this.scheduleCalendarUnlock(opts.companyId);
      if (status === 'approved') {
        await this.markKickoffLoopDone(opts.companyId, opts.threadId, status);
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

      const replySnap = await getDoc(doc(db, `companies/${opts.companyId}/inbox/${opts.parentId}`));
      if (!replySnap.exists()) return;
      const replyDoc = (replySnap.data() as any) || {};

      // For replies, the work item metadata lives on the original assist email, not the reply doc.
      // Try to resolve the original parent message if the reply has a parentId.
      let parent = replyDoc;
      if ((!parent.workitemId && !parent.workitem_id) && replyDoc.parentId) {
        try {
          const origSnap = await getDoc(doc(db, `companies/${opts.companyId}/inbox/${replyDoc.parentId}`));
          if (origSnap.exists()) {
            parent = (origSnap.data() as any) || {};
          }
        } catch {}
      }

      const workitemId = String(parent.workitemId || parent.workitem_id || '').trim();
      if (!workitemId) return;

      const product = await this.getAcceptedProduct(opts.companyId, parent);
      const workitemCtx = await this.getWorkitemContext(opts.companyId, workitemId, parent);
      const workerName = String(parent.senderName || parent.workerName || workitemCtx.assigneeName || 'Teammate');
      const workerTitle = String(parent.senderTitle || parent.workerTitle || workitemCtx.assigneeTitle || 'Contributor');
      const thread = threadItems;

      const reviewPayload = {
        company: opts.companyId,
        product,
        workitem: {
          id: workitemId,
          title: workitemCtx.title,
          description: workitemCtx.description,
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
      if (!review) return;

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
      const ratesMap = workitemData.rates && typeof workitemData.rates === 'object' ? workitemData.rates : null;
      const assigneeRateRaw =
        ratesMap && workitemCtx.assigneeId ? Number((ratesMap as any)[workitemCtx.assigneeId]) : Number.NaN;
      const baseRateCandidate = Number.isFinite(assigneeRateRaw) && assigneeRateRaw > 0 ? assigneeRateRaw : baseRateRaw;
      const baseRate = Number.isFinite(baseRateCandidate) && baseRateCandidate > 0 ? baseRateCandidate : 1;
      let nextRate = baseRate * multiplier;
      if (!Number.isFinite(nextRate) || nextRate <= 0) nextRate = baseRate;
      nextRate = Math.max(0.1, Math.min(5, Math.round(nextRate * 10000) / 10000));
      const estimatedHours = Math.max(1, Math.round(100 / nextRate));
      const simTime = await this.getCompanySimTime(opts.companyId);

      const updatePayload: Record<string, any> = {
        assist_status: 'resolved',
        rate_per_hour: nextRate,
        estimated_hours: estimatedHours,
        started_at: simTime,
        updated: serverTimestamp(),
      };
      const normalizedExisting: Record<string, number> = {};
      if (ratesMap && typeof ratesMap === 'object') {
        for (const [empId, val] of Object.entries(ratesMap as Record<string, any>)) {
          const num = Number(val);
          if (Number.isFinite(num)) normalizedExisting[empId] = num;
        }
      }
      if (workitemCtx.assigneeId) {
        normalizedExisting[workitemCtx.assigneeId] = nextRate;
      }
      updatePayload['rates'] = normalizedExisting;

      await updateDoc(workitemRef, updatePayload);

      const evaluationStamp = new Date(simTime).toISOString();
      await setDoc(
        doc(db, `companies/${opts.companyId}/inbox/${opts.parentId}`),
        {
          assistEvaluatedAt: evaluationStamp,
        },
        { merge: true }
      );

      let followBody = typeof followUp.body === 'string' ? followUp.body : '';
      if (followBody.trim().length) {
        followBody = await this.appendThreadHistory({
          companyId: opts.companyId,
          threadId: opts.threadId,
          body: followBody,
          threadItems,
        });
        const threadSubject =
          opts.subject ||
          parent.subject ||
          workitemCtx.subject ||
          workitemCtx.title ||
          '(no subject)';
        const followSubject = threadSubject;
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
    const to = opts.to || '';
    const normalized = this.normalizeAddress(to);
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
    if (normalized === 'mom@altavista.net') {
      await this.handleMomConversation({
        companyId: opts.companyId,
        subject: opts.subject,
        message: opts.message,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
      });
      return;
    }
    if (this.isSupereatsAddress(normalized)) {
      await this.handleSupereatsConversation({
        companyId: opts.companyId,
        subject: opts.subject,
        message: opts.message,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
      });
      return;
    }
    if (this.isCadabraAddress(normalized)) {
      await this.handleCadabraConversation({
        companyId: opts.companyId,
        subject: opts.subject,
        message: opts.message,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
      });
      return;
    }
    if (this.isBankAddress(normalized)) {
      await this.sendBankAutoReply({
        companyId: opts.companyId,
        subject: opts.subject,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
      });
      return;
    }
    const employee = await this.matchEmployeeRecipient(opts.companyId, to);
    if (employee) {
      await this.handleEmployeeEmail({
        companyId: opts.companyId,
        to,
        subject: opts.subject,
        message: opts.message,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
        employee,
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

  private async handleCadabraConversation(opts: {
    companyId: string;
    subject: string;
    message: string;
    threadId: string;
    parentId?: string;
    timestamp?: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
  }): Promise<void> {
    const meAddress = await this.getMeAddress(opts.companyId);
    const payload = {
      company: opts.companyId,
      subject: opts.subject || '(no subject)',
      message: opts.message || '',
      threadId: opts.threadId,
    };
    let res: any = null;
    try {
      res = await this.http
        .post<any>('https://fa-strtupifyio.azurewebsites.net/api/cadabra_reply', payload)
        .toPromise();
    } catch (err) {
      console.error('cadabra reply failed', err);
    }
    const from = res?.from || 'jeff@cadabra.com';
    const subject = opts.subject || res?.subject || '(no subject)';
    let body = typeof res?.body === 'string' ? res.body : '';
    body = body.trim();
    if (!body) {
      body = 'This is Jeff. Something in here feels wrong. Stay on the line.';
    }
    body = await this.appendThreadHistory({
      companyId: opts.companyId,
      threadId: opts.threadId,
      body,
      threadItems: opts.threadItems,
    });
    const attempt = Number(res?.attempt);
    const urgency = Number(res?.urgency);
    const understanding = Number(res?.understanding);
    const temperature = Number(res?.temperature);
    const emailId = `cadabra-reply-${Date.now()}`;
    const simNow = await this.getCompanySimTime(opts.companyId);
    const baseTs = opts.timestamp ? new Date(opts.timestamp) : null;
    const baseMs = baseTs && baseTs.toString() !== 'Invalid Date' ? baseTs.getTime() : Number.NaN;
    const tsMs = Math.max(simNow, Number.isFinite(baseMs) ? baseMs + 1 : simNow);
    const timestampIso = new Date(tsMs).toISOString();
    const docPayload: any = {
      from,
      to: meAddress,
      subject,
      message: body,
      deleted: false,
      banner: false,
      timestamp: timestampIso,
      threadId: opts.threadId,
      category: 'cadabra',
      avatarUrl:
        from.toLowerCase() === 'jeff@cadabra.com'
          ? 'assets/jeff.svg'
          : 'assets/cadabra-avatar.png',
    };
    if (opts.parentId) docPayload.parentId = opts.parentId;
    if (Number.isFinite(attempt)) docPayload.cadabraReplyAttempt = attempt;
    if (Number.isFinite(urgency)) docPayload.cadabraUrgency = urgency;
    if (Number.isFinite(understanding)) docPayload.cadabraUnderstanding = understanding;
    if (Number.isFinite(temperature)) docPayload.cadabraTemperature = temperature;
    await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), docPayload);
  }

  private async handleSupereatsConversation(opts: {
    companyId: string;
    subject: string;
    message: string;
    threadId: string;
    parentId?: string;
    timestamp?: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
  }): Promise<void> {
    const meAddress = await this.getMeAddress(opts.companyId);
    const decision = await this.classifySupereatsCancellation(opts.message || '');
    const baseSubject = (opts.subject || '').trim() || '(no subject)';

    if (!decision.cancel) {
      await this.sendSupereatsTemplateEmail({
        companyId: opts.companyId,
        templatePath: 'emails/supereats-generic.md',
        fallbackSubject: `Re: ${baseSubject}`,
        meAddress,
        threadId: opts.threadId,
        parentId: opts.parentId,
        timestamp: opts.timestamp,
        threadItems: opts.threadItems,
      });
      return;
    }

    const stage = await this.advanceSupereatsCancelStage(opts.companyId);
    const templatePath = this.supereatsTemplateForStage(stage);
    await this.sendSupereatsTemplateEmail({
      companyId: opts.companyId,
      templatePath,
      fallbackSubject: `Re: ${baseSubject}`,
      meAddress,
      threadId: opts.threadId,
      parentId: opts.parentId,
      timestamp: opts.timestamp,
      threadItems: opts.threadItems,
    });

    if (stage >= 4) {
      await this.disableSuperEatsEmails(opts.companyId);
    }
  }

  private async handleMomConversation(opts: {
    companyId: string;
    subject: string;
    message: string;
    threadId: string;
    parentId?: string;
    timestamp?: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
  }): Promise<void> {
    const meAddress = await this.getMeAddress(opts.companyId);
    const payload = {
      company: opts.companyId,
      subject: opts.subject || '(no subject)',
      message: opts.message || '',
    };
    let res: any = null;
    try {
      res = await this.http
        .post<any>('https://fa-strtupifyio.azurewebsites.net/api/mom_reply', payload)
        .toPromise();
    } catch (err) {
      console.error('mom reply failed', err);
    }
    const status = String(res?.status || '').toLowerCase();
    const grant = status === 'grant' && res?.grant && Number(res?.amount) > 0;
    const amount = grant ? Number(res?.amount) : 0;
    const memo = grant ? String(res?.ledgerMemo || 'Gift from Mom') : '';
    const from = res?.from || 'mom@altavista.net';
    const subject = opts.subject || res?.subject || '(no subject)';
    let body = res?.body || '';
    if (!body || !body.trim()) {
      body =
        status === 'grant'
          ? 'Sweetie, you were so thoughtful. I just sent you $10,000. Try not to spend it all at once. Love, Mom.'
          : 'Hi, thanks for writing. I am worried about you—do you need money? Love, Mom.';
    }
    body = await this.appendThreadHistory({
      companyId: opts.companyId,
      threadId: opts.threadId,
      body,
      threadItems: opts.threadItems,
    });
    const emailId = `mom-reply-${Date.now()}`;
    const baseTs = opts.timestamp ? new Date(opts.timestamp) : new Date();
    const delayMs = this.randomInt(25_000, 75_000); // stagger to feel more realistic
    const sendAt = Math.max(baseTs.getTime() + 1, Date.now() + delayMs);
    const timestampIso = new Date(sendAt).toISOString(); // ensure replies sort after the outbound message and include delay
    const category = grant ? 'mom-gift' : 'mom-reply';
    const docPayload: any = {
      from,
      to: meAddress,
      subject,
      message: body,
      deleted: false,
      banner: false,
      timestamp: timestampIso,
      threadId: opts.threadId,
      category,
      avatarUrl: 'assets/mom.jpg',
    };
    if (opts.parentId) docPayload.parentId = opts.parentId;
    if (grant) {
      docPayload.ledgerAmount = amount;
      docPayload.ledgerMemo = memo;
      docPayload.ledger = { type: 'mom-gift', amount, memo };
      docPayload.momGiftAmount = amount;
    }
    const sendReply = async () => {
      try {
        await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), docPayload);
        if (grant) {
          try {
            await setDoc(
              doc(db, `companies/${opts.companyId}`),
              {
                ledgerEnabled: true,
                momGiftGranted: true,
              },
              { merge: true }
            );
          } catch {}
        }
      } catch (err) {
        console.error('failed to send mom reply', err);
      }
    };

    // Fire-and-forget the delayed send so the UI isn't blocked while we wait.
    // Use the short human-like delay, not the simulated timestamp delta, so replies
    // still show up even if the sim clock is far in the future.
    setTimeout(() => {
      void sendReply();
    }, Math.max(0, delayMs));
  }

  private supereatsTemplateForStage(stage: number): string {
    if (stage >= 4) return 'emails/supereats-cancel-block.md';
    if (stage === 3) return 'emails/supereats-cancel-gold.md';
    if (stage === 2) return 'emails/supereats-cancel-plus.md';
    return 'emails/supereats-cancel-ack.md';
  }

  private async classifySupereatsCancellation(
    message: string
  ): Promise<{ cancel: boolean; confidence: number; source: string }> {
    const text = (message || '').trim();
    if (!text) return { cancel: false, confidence: 0, source: 'empty' };
    try {
      const res = await this.http
        .post<any>('https://fa-strtupifyio.azurewebsites.net/api/supereats_cancel', {
          message: text,
        })
        .toPromise();
      const cancel = !!(res && res.cancel);
      const confidence = Number(res && res.confidence);
      const source = String((res && res.source) || 'api');
      return {
        cancel,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        source,
      };
    } catch {
      const lower = text.toLowerCase();
      const keywords = ['cancel', 'stop', 'undo', 'wrong order', 'do not charge', 'reverse'];
      const cancel = keywords.some((k) => lower.includes(k));
      return { cancel, confidence: cancel ? 0.4 : 0, source: 'fallback' };
    }
  }

  private async advanceSupereatsCancelStage(companyId: string): Promise<number> {
    const ref = doc(db, `companies/${companyId}`);
    const now = new Date().toISOString();
    let stage = 1;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        const prev = Number.isFinite(data.superEatsCancelStage)
          ? Number(data.superEatsCancelStage)
          : 0;
        stage = Math.min(4, Math.max(1, prev + 1));
        const update: any = {
          superEatsCancelStage: stage,
          superEatsCancelUpdatedAt: now,
        };
        if (stage >= 4) {
          update.superEatsNextAt = null;
          update.superEatsEmailInProgress = false;
          update.superEatsCancelled = true;
          update.superEatsCancelledAt = now;
        }
        tx.set(ref, update, { merge: true });
      });
    } catch {
      try {
        const update: any = {
          superEatsCancelStage: stage,
          superEatsCancelUpdatedAt: now,
          superEatsCancelled: stage >= 4,
        };
        if (stage >= 4) {
          update.superEatsCancelledAt = now;
          update.superEatsNextAt = null;
          update.superEatsEmailInProgress = false;
        }
        await setDoc(ref, update, { merge: true });
      } catch {}
    }
    return stage;
  }

  private async disableSuperEatsEmails(companyId: string): Promise<void> {
    const ref = doc(db, `companies/${companyId}`);
    const now = new Date().toISOString();
    try {
      await setDoc(
        ref,
        {
          superEatsNextAt: null,
          superEatsEmailInProgress: false,
          superEatsCancelled: true,
          superEatsCancelledAt: now,
        },
        { merge: true }
      );
    } catch {}
  }

  private async sendSupereatsTemplateEmail(opts: {
    companyId: string;
    templatePath: string;
    fallbackSubject: string;
    meAddress: string;
    threadId: string;
    parentId?: string;
    timestamp?: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
  }): Promise<void> {
    let template: { from?: string; subject?: string; banner?: boolean; deleted?: boolean; body: string } = {
      body: '',
    };
    try {
      template = await this.loadTemplate(opts.templatePath);
    } catch {
      template = { body: '' };
    }
    const from = template.from || 'support@supereats.com';
    const subject = template.subject || opts.fallbackSubject || 'Re: Your Super Eats order';
    const message =
      (template.body || '').trim() ||
      'Your email has been received. Thank you for contacting Super Eats support.';
    const messageWithHistory = await this.appendThreadHistory({
      companyId: opts.companyId,
      threadId: opts.threadId,
      body: message,
      threadItems: opts.threadItems,
    });
    const deleted = typeof template.deleted === 'boolean' ? template.deleted : false;
    const banner = typeof template.banner === 'boolean' ? template.banner : true;
    const emailId = `supereats-reply-${Date.now()}`;
    const simNow = await this.getCompanySimTime(opts.companyId);
    const base = opts.timestamp ? new Date(opts.timestamp) : null;
    const baseMs = base && base.toString() !== 'Invalid Date' ? base.getTime() : Number.NaN;
    const timestamp = new Date(Math.max(simNow, Number.isFinite(baseMs) ? baseMs + 1 : simNow)).toISOString();
    const payload: any = {
      from,
      to: opts.meAddress,
      subject,
      message: messageWithHistory,
      deleted,
      banner,
      timestamp,
      threadId: opts.threadId,
      category: 'supereats',
      avatarUrl: 'assets/supereats-avatar.png',
    };
    if (opts.parentId) payload.parentId = opts.parentId;
    await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), payload);
  }

  private async sendBankAutoReply(opts: {
    companyId: string;
    subject: string;
    threadId: string;
    parentId?: string;
    timestamp?: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
  }): Promise<void> {
    const meAddress = await this.getMeAddress(opts.companyId);
    const { ticket, etaHours, etaText } = await this.nextBankTicket(opts.companyId);
    const subjectLabel = (opts.subject || '').trim() || '(no subject)';
    const context: Record<string, string> = {
      SUBJECT: subjectLabel,
      TICKET_NUMBER: ticket,
      ETA_TEXT: etaText,
      ETA_HOURS: String(Math.max(1, Math.round(etaHours || 0))),
    };

    let from = 'compliance@54.com';
    let subject = `Re: ${subjectLabel}`;
    let banner = true;
    let deleted = false;
    const fallbackLines = [
      'Fifth Fourth Bank Automated Notice',
      '',
      'This communication may contain privileged or confidential information intended solely for the recipient. Unauthorized review, use, or disclosure is prohibited and may violate applicable banking regulations.',
      '',
      `Ticket ${ticket} has been logged for your message. Estimated response ETA: ${etaText}.`,
      'Correspondence may be monitored and retained for supervision, audit, and quality assurance purposes.',
      '',
      'Do not transmit payment instructions or account changes via unsecured email. Contact your Relationship Manager for urgent matters.',
      '',
      'Thank you for banking with Fifth Fourth Bank.',
    ];
    let body = fallbackLines.join('\n');

    try {
      const template = await this.loadTemplate('emails/bank-autoreply.md');
      const rendered = this.renderTemplate(template, context);
      from = rendered.from || from;
      subject = rendered.subject || subject;
      banner = typeof rendered.banner === 'boolean' ? rendered.banner : banner;
      deleted = typeof rendered.deleted === 'boolean' ? rendered.deleted : deleted;
      body = rendered.body || body;
    } catch {}

    body = await this.appendThreadHistory({
      companyId: opts.companyId,
      threadId: opts.threadId,
      body,
      threadItems: opts.threadItems,
    });

    const base = opts.timestamp ? new Date(opts.timestamp) : new Date();
    const timestamp = new Date(base.getTime() + 1).toISOString();
    const emailId = `bank-auto-${Date.now()}`;
    const payload: any = {
      from,
      to: meAddress,
      subject,
      message: body,
      deleted,
      banner,
      timestamp,
      threadId: opts.threadId,
      category: 'bank',
      bankTicketNumber: ticket,
      bankEtaHours: etaHours,
      bankEtaText: etaText,
    };
    if (opts.parentId) payload.parentId = opts.parentId;
    await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), payload);
  }

  private async nextBankTicket(companyId: string): Promise<{ ticket: string; etaHours: number; etaText: string }> {
    const ref = doc(db, `companies/${companyId}`);
    let ticketNumber = this.formatBankTicket(1);
    let etaHours = 72;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        const prevCounter =
          typeof data.bankAutoTicketCounter === 'number' && Number.isFinite(data.bankAutoTicketCounter)
            ? Math.max(0, Math.floor(data.bankAutoTicketCounter))
            : 0;
        const prevEta =
          typeof data.bankAutoEtaHours === 'number' && Number.isFinite(data.bankAutoEtaHours) && data.bankAutoEtaHours > 0
            ? Number(data.bankAutoEtaHours)
            : 36;
        const nextCounter = prevCounter + 1;
        const today = new Date();
        const dayOfMonth = Math.max(1, Math.min(31, today.getDate()));
        const additiveBump = this.randomInt(1, dayOfMonth);
        const multiplicativeBump = 1.5 + Math.random(); // 1.5–2.5
        const roll = Math.random();
        let nextEta = prevEta;
        if (roll < 0.1) {
          // 10%: do both add then multiply
          nextEta = (nextEta + additiveBump) * multiplicativeBump;
        } else if (roll < 0.55) {
          // ~45%: additive only
          nextEta = nextEta + additiveBump;
        } else {
          // ~45%: multiplicative only
          nextEta = nextEta * multiplicativeBump;
        }
        const roundedEta = Math.max(1, Math.round(nextEta));
        const safeEta = roundedEta <= prevEta ? prevEta + additiveBump + 1 : roundedEta;
        tx.set(
          ref,
          {
            bankAutoTicketCounter: nextCounter,
            bankAutoEtaHours: safeEta,
            bankAutoUpdatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        ticketNumber = this.formatBankTicket(nextCounter);
        etaHours = safeEta;
      });
    } catch {
      try {
        const fallbackCounter = this.randomInt(1000, 9999);
        const fallbackEta = this.randomInt(48, 96);
        await setDoc(
          ref,
          { bankAutoTicketCounter: fallbackCounter, bankAutoEtaHours: fallbackEta, bankAutoUpdatedAt: new Date().toISOString() },
          { merge: true }
        );
        ticketNumber = this.formatBankTicket(fallbackCounter);
        etaHours = fallbackEta;
      } catch {}
    }
    const etaText = this.describeBankEta(etaHours);
    return { ticket: ticketNumber, etaHours, etaText };
  }

  private formatBankTicket(counter: number): string {
    const safe = Number.isFinite(counter) && counter > 0 ? Math.floor(counter) : 1;
    return `54-${safe.toString().padStart(6, '0')}`;
  }

  private describeBankEta(hours: number): string {
    if (!Number.isFinite(hours) || hours <= 0) return '72 hours';
    const rounded = Math.max(1, Math.round(hours));
    if (rounded >= 24) {
      const days = Math.ceil(rounded / 24);
      return `${days} business day${days === 1 ? '' : 's'}`;
    }
    return `${rounded} hours`;
  }

  private normalizeLocalPart(source: string): string {
    const normalized = (source || 'teammate').toLowerCase().replace(/[^a-z0-9]+/g, '.');
    const trimmed = normalized.replace(/^\.+|\.+$/g, '');
    return trimmed || 'teammate';
  }

  private async employeeDomain(companyId: string): Promise<string> {
    try {
      const me = await this.getMeAddress(companyId);
      const parts = me.split('@');
      if (parts.length === 2 && parts[1]) return parts[1].toLowerCase();
    } catch {}
    const base = (companyId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${base || 'strtupify'}.com`;
  }

  private async matchEmployeeRecipient(
    companyId: string,
    address: string
  ): Promise<{ id: string; name: string; title: string; email: string; offHoursAllowed?: boolean } | null> {
    const normalized = this.normalizeAddress(address);
    if (!normalized || !normalized.includes('@')) return null;
    const domain = await this.employeeDomain(companyId);
    try {
      const snap = await getDocs(
        query(collection(db, `companies/${companyId}/employees`), where('hired', '==', true))
      );
      for (const d of snap.docs) {
        const data = (d.data() as any) || {};
        const name = String(data.name || d.id);
        const title = String(data.title || '');
        const offHoursAllowed = data.offHoursAllowed === true || data.off_hours_allowed === true;
        const predicted = `${this.normalizeLocalPart(name)}@${domain}`;
        const idAlias = `${this.normalizeLocalPart(d.id)}@${domain}`;
        if (normalized === predicted || normalized === idAlias) {
          return { id: d.id, name, title, email: predicted, offHoursAllowed };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private async handleEmployeeEmail(opts: {
    companyId: string;
    to: string;
    subject: string;
    message: string;
    threadId: string;
    parentId?: string;
    timestamp?: string;
    employee: { id: string; name: string; title?: string; email?: string; offHoursAllowed?: boolean };
  }): Promise<void> {
    const payload = {
      company: opts.companyId,
      to: opts.to,
      subject: opts.subject || '(no subject)',
      message: opts.message || '',
      threadId: opts.threadId,
      parentId: opts.parentId,
      employee_id: opts.employee.id,
    };
    let res: any = null;
    try {
      res = await this.http
        .post<any>('https://fa-strtupifyio.azurewebsites.net/api/employee_email', payload)
        .toPromise();
    } catch (err) {
      console.error('employee email evaluation failed', err);
      return;
    }
    const baseReply = res?.reply;
    const reply = baseReply;
    if (!reply || typeof reply.body !== 'string' || !reply.body.trim().length) return;
    const meAddress = await this.getMeAddress(opts.companyId);
    const from =
      reply.from || opts.employee.email || this.buildWorkerAddress(opts.employee.name, opts.companyId);
    const subject = reply.subject || `Re: ${opts.subject || '(no subject)'}`;
    const messageBody = await this.appendThreadHistory({
      companyId: opts.companyId,
      threadId: opts.threadId,
      body: String(reply.body || ''),
    });
    if (!messageBody.trim()) return;

    const simState = await this.getCompanySimState(opts.companyId);
    const parsedBase =
      opts.timestamp && new Date(opts.timestamp).toString() !== 'Invalid Date'
        ? new Date(opts.timestamp)
        : null;
    const baseSimMs = parsedBase ? parsedBase.getTime() : simState.simTime;
    const hadOffHours = opts.employee.offHoursAllowed === true;
    const grantsOffHours = res?.offHoursAllowed === true;
    const allowOffHours = hadOffHours; // new off-hours permission applies after this reply is sent
    const targetSimMs = this.scheduleEmployeeSimReply(baseSimMs, allowOffHours);
    const plannedSimMs = Math.max(targetSimMs, simState.simTime + 1);
    const simLag = Math.max(0, plannedSimMs - simState.simTime);
    const speed = Number.isFinite(simState.speed) && simState.speed > 0 ? simState.speed : 1;
    const approxDelay = simLag > 0 ? simLag / speed : 0;
    const jitter = this.randomInt(10_000, 40_000);
    const minDelay = allowOffHours ? 60_000 : 120_000; // mimic human response lag
    const sendDelayMs = Math.max(minDelay, Math.round(approxDelay + jitter));
    const emailId = `employee-reply-${Date.now()}`;
    const baseDocPayload = {
      from,
      to: meAddress,
      subject,
      message: messageBody,
      deleted: false,
      banner: false,
      threadId: opts.threadId,
      parentId: opts.parentId,
      category: 'employee',
      employeeId: opts.employee.id,
      employeeIntent: res?.intent || 'neutral',
      offHoursAllowed: grantsOffHours || hadOffHours,
    };
    const sendReply = async () => {
      try {
        const liveSim = await this.getCompanySimState(opts.companyId);
        const liveSimMs = Number.isFinite(liveSim.simTime) ? liveSim.simTime : simState.simTime;
        const estimatedSimMs = simState.simTime + sendDelayMs * speed;
        const timestampMs = Math.max(plannedSimMs, estimatedSimMs, liveSimMs);
        const docPayload = {
          ...baseDocPayload,
          timestamp: new Date(timestampMs).toISOString(),
        };
        await setDoc(doc(db, `companies/${opts.companyId}/inbox/${emailId}`), docPayload);
      } catch (err) {
        console.error('failed to send employee reply', err);
      }
    };
    setTimeout(() => {
      void sendReply();
    }, Math.max(0, sendDelayMs));
  }

  private async sendMailerDaemonBounce(opts: {
    companyId: string;
    to: string;
    subject: string;
    message: string;
    threadId: string;
    parentId: string;
    timestamp?: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
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

    body = await this.appendThreadHistory({
      companyId: opts.companyId,
      threadId: opts.threadId,
      body,
      threadItems: opts.threadItems,
    });

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

  private minutesIntoDay(date: Date): number {
    return date.getHours() * 60 + date.getMinutes();
  }

  private isWorkday(date: Date): boolean {
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }

  private isWithinWorkHours(date: Date): boolean {
    const minutes = this.minutesIntoDay(date);
    return minutes >= this.workdayStartHour * 60 && minutes <= this.workdayEndHour * 60;
  }

  private endOfWorkday(date: Date): Date {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      this.workdayEndHour,
      0,
      0,
      0
    );
  }

  private nextWorkMorning(base: Date): Date {
    const candidate = new Date(base.getTime());
    candidate.setSeconds(0, 0);
    if (this.isWorkday(candidate) && this.minutesIntoDay(candidate) < this.workdayStartHour * 60) {
      return new Date(
        candidate.getFullYear(),
        candidate.getMonth(),
        candidate.getDate(),
        this.workdayStartHour,
        0,
        0,
        0
      );
    }
    const next = new Date(candidate.getTime());
    do {
      next.setDate(next.getDate() + 1);
    } while (!this.isWorkday(next));
    return new Date(next.getFullYear(), next.getMonth(), next.getDate(), this.workdayStartHour, 0, 0, 0);
  }

  private scheduleMorningReply(base: Date): Date {
    const morning = this.nextWorkMorning(base);
    const minuteOffset = this.randomInt(0, 59);
    const secondOffset = this.randomInt(0, 59);
    return new Date(
      morning.getFullYear(),
      morning.getMonth(),
      morning.getDate(),
      morning.getHours(),
      minuteOffset,
      secondOffset,
      0
    );
  }

  private scheduleEmployeeSimReply(baseMs: number, allowOffHours: boolean): number {
    const safeBaseMs = Number.isFinite(baseMs) ? baseMs : Date.now();
    const baseDate = new Date(safeBaseMs);
    const withinHours = this.isWorkday(baseDate) && this.isWithinWorkHours(baseDate);
    if (allowOffHours) {
      return safeBaseMs + this.randomInt(20_000, 60_000);
    }
    const endOfDay = this.endOfWorkday(baseDate).getTime();
    if (!withinHours) {
      return this.scheduleMorningReply(baseDate).getTime();
    }
    const candidate = safeBaseMs + this.randomInt(20_000, 60_000);
    if (candidate <= endOfDay) {
      return candidate;
    }
    return this.scheduleMorningReply(baseDate).getTime();
  }

  private normalizeHistoryDivider(text: string): string {
    if (!text) return '';
    return text
      .replace(
        /-----\s*(original (?:message|email)|previous (?:emails?|repl(?:y|ies)))\s*-----/gi,
        this.historyDivider
      )
      .replace(
        /(^|\n)\s*-*\s*previous\s+repl(?:y|ies)\s*-*\s*(\n|$)/gi,
        (_m, prefix, suffix) => `${prefix}${this.historyDivider}${suffix}`
      );
  }

  private hasHistoryBlock(text: string): boolean {
    if (!text) return false;
    return (
      this.historyRegex.test(text) ||
      /(^|\n)\s*-*\s*previous\s+repl(?:y|ies)\s*-*\s*($|\n)/i.test(text)
    );
  }

  private stripQuotedHistory(text: string | undefined | null): string {
    if (!text) return '';
    const normalized = this.normalizeHistoryDivider(String(text));
    const markers = [
      normalized.search(this.historyRegex),
      normalized.search(/^[-\s]*original (message|email)\s*:/im),
      normalized.search(/^[-\s]*previous (message|messages|email|emails|reply|replies)\s*:/im),
      normalized.search(/^\s*-*\s*previous\s+repl(?:y|ies)\s*-*\s*$/im),
    ].filter((idx) => idx >= 0);
    const cutIdx = markers.length ? Math.min(...markers) : -1;
    const base = cutIdx >= 0 ? normalized.slice(0, cutIdx) : normalized;
    return base.trimEnd();
  }

  private formatThreadTimestamp(raw?: string): string {
    if (!raw) return '';
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
  }

  private buildHistoryBlock(
    thread: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>
  ): string {
    if (!Array.isArray(thread) || !thread.length) return '';
    const seen = new Set<string>();
    const sorted = thread
      .slice()
      .sort((a, b) => new Date(b.timestamp || '').getTime() - new Date(a.timestamp || '').getTime());
    const lines: string[] = [this.historyDivider];
    sorted.forEach((item) => {
      const key = item.id || `${item.from || ''}|${item.timestamp || ''}|${item.message || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      const sender = (item.from || 'Unknown sender').trim() || 'Unknown sender';
      const headerTs = this.formatThreadTimestamp(item.timestamp);
      const header = headerTs ? `From: ${sender} - ${headerTs}` : `From: ${sender}`;
      const body = this.stripQuotedHistory(item.message).trim();
      lines.push(header);
      if (body) lines.push(body);
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  private async appendThreadHistory(opts: {
    companyId: string;
    threadId: string;
    body: string;
    threadItems?: Array<{ id?: string; from?: string; message?: string; timestamp?: string }>;
  }): Promise<string> {
    const normalizedBase = this.normalizeHistoryDivider(opts.body || '');
    if (this.hasHistoryBlock(normalizedBase)) return normalizedBase;
    const cleanedBase = this.stripQuotedHistory(normalizedBase);
    const thread =
      Array.isArray(opts.threadItems) && opts.threadItems.length
        ? opts.threadItems
        : await this.getThreadItems(opts.companyId, opts.threadId);
    const history = this.buildHistoryBlock(thread);
    if (!history) return cleanedBase;
    const needsGap = cleanedBase.trim().length > 0;
    return needsGap ? `${cleanedBase}\n\n${history}` : history;
  }

  private appendOriginalMessage(replyBody: string, original: string): string {
    const base = this.normalizeHistoryDivider(typeof replyBody === 'string' ? replyBody : '');
    if (this.hasHistoryBlock(base)) return base;
    const originalText = this.stripQuotedHistory(original).trim();
    if (!originalText) return base;
    const needsGap = base.trim().length > 0;
    return `${base}${needsGap ? '\n\n' : ''}${this.historyDivider}\n${originalText}`;
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
        assigneeId: undefined,
        assigneeName: parent.senderName || undefined,
        assigneeTitle: parent.senderTitle || undefined,
        subject: String(parent.subject || ''),
        body: String(parent.message || ''),
        pauseReason: String(parent.assistPauseReason || ''),
      };
    }
  }

  private async scheduleCalendarUnlock(companyId: string): Promise<void> {
    const ref = doc(db, `companies/${companyId}`);
    const simTime = await this.getCompanySimTime(companyId);
    const target = simTime + this.kickoffLeadMs;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const data = (snap && (snap.data() as any)) || {};
        if (data.calendarEmailSent) return;
        if (typeof data.calendarEmailAt === 'number') return;
        tx.set(
          ref,
          {
            calendarEmailAt: target,
            calendarEmailSent: false,
            calendarEmailInProgress: false,
            calendarEnabled: false,
          },
          { merge: true }
        );
      });
    } catch {
      try {
        await setDoc(
          ref,
          {
            calendarEmailAt: target,
            calendarEmailSent: false,
            calendarEmailInProgress: false,
            calendarEnabled: false,
          },
          { merge: true }
        );
      } catch {}
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

  private async getCompanySimState(companyId: string): Promise<{ simTime: number; speed: number }> {
    try {
      const snap = await getDoc(doc(db, `companies/${companyId}`));
      const data = (snap.data() as any) || {};
      const simTime = Number(data.simTime || Date.now());
      const speed = Number(data.speed || 1);
      const safeSim = Number.isFinite(simTime) && simTime > 0 ? simTime : Date.now();
      const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
      return { simTime: safeSim, speed: safeSpeed };
    } catch {
      return { simTime: Date.now(), speed: 1 };
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

  private async getReplyDoc(
    companyId: string,
    replyId?: string | null
  ): Promise<any | null> {
    if (!replyId) return null;
    try {
      const snap = await getDoc(doc(db, `companies/${companyId}/inbox/${replyId}`));
      if (!snap.exists()) return null;
      return (snap.data() as any) || null;
    } catch {
      return null;
    }
  }

  private async kickoffLoopFinished(companyId: string): Promise<boolean> {
    try {
      const snap = await getDoc(doc(db, `companies/${companyId}`));
      const data = (snap.data() as any) || {};
      if (data.kickoffLoopDone === true) return true;
      if (data.work_enabled === true || data.workEnabled === true) return true;
    } catch {}
    return false;
  }

  private async markKickoffLoopDone(
    companyId: string,
    threadId?: string,
    status?: string
  ): Promise<void> {
    try {
      const payload: any = {
        kickoffLoopDone: true,
        kickoffLoopUpdatedAt: new Date().toISOString(),
      };
      if (threadId) payload.kickoffLoopThreadId = threadId;
      if (status) payload.kickoffLoopStatus = status;
      await setDoc(doc(db, `companies/${companyId}`), payload, { merge: true });
    } catch {}
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

  private normalizeAddress(raw: string): string {
    const text = String(raw || '').trim().toLowerCase();
    if (!text) return '';
    const match = text.match(/<([^>]+)>/);
    const addr = match ? match[1] : text;
    return addr.trim();
  }

  private isCadabraAddress(address: string): boolean {
    const normalized = this.normalizeAddress(address);
    if (!normalized) return false;
    return (
      normalized === 'order-update@cadabra.com' ||
      normalized === 'updates@cadabra.com' ||
      normalized === 'jeff@cadabra.com' ||
      normalized.endsWith('@cadabra.com')
    );
  }

  private isSupereatsAddress(address: string): boolean {
    const normalized = this.normalizeAddress(address);
    if (!normalized) return false;
    return normalized === 'noreply@supereats.com' || normalized.endsWith('@supereats.com');
  }

  private isBankAddress(address: string): boolean {
    const normalized = this.normalizeAddress(address);
    if (!normalized) return false;
    return (
      normalized === 'noreply@54.com' ||
      normalized === 'noreply@54bank.com' ||
      normalized.endsWith('@54.com') ||
      normalized.endsWith('@54bank.com') ||
      normalized.includes('fifthfourth')
    );
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
