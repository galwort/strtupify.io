import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiStateService {
  private _showCompanyProfile = new BehaviorSubject<boolean>(false);
  readonly showCompanyProfile$ = this._showCompanyProfile.asObservable();

  setShowCompanyProfile(show: boolean) {
    this._showCompanyProfile.next(show);
  }

  toggleCompanyProfile() {
    this._showCompanyProfile.next(!this._showCompanyProfile.value);
  }
}

