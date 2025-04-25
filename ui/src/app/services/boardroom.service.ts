import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class BoardroomService {
  private api = 'https://fa-strtupifyio.azurewebsites.net/api'
  constructor(private http: HttpClient) {}

  start(companyId: string) {
    return this.http.post<{
      productId: string;
      speaker: string;
      line: string;
    }>(`${this.api}/start_boardroom`, { company: companyId });
  }

  step(companyId: string, productId: string) {
    return this.http.post<{
      speaker: string;
      line: string;
      outcome: { name: string; description: string };
      done: boolean;
    }>(`${this.api}/boardroom_step`, { company: companyId, product: productId });
  }
}
