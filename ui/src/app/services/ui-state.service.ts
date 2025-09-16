import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UiStateService {
  private _showCompanyProfile = new BehaviorSubject<boolean>(false);
  readonly showCompanyProfile$ = this._showCompanyProfile.asObservable();

  // Controls when the company profile icon should be available in the sidebar
  private _companyProfileEnabled = new BehaviorSubject<boolean>(false);
  readonly companyProfileEnabled$ = this._companyProfileEnabled.asObservable();

  private _currentModule = new BehaviorSubject<'inbox' | 'roles' | 'resumes' | 'boardroom'>('roles');
  readonly currentModule$ = this._currentModule.asObservable();

  setShowCompanyProfile(show: boolean) {
    this._showCompanyProfile.next(show);
  }

  toggleCompanyProfile() {
    this._showCompanyProfile.next(!this._showCompanyProfile.value);
  }

  setCompanyProfileEnabled(enabled: boolean) {
    this._companyProfileEnabled.next(enabled);
  }

  setCurrentModule(m: 'inbox' | 'roles' | 'resumes' | 'boardroom') {
    this._currentModule.next(m);
  }
}
