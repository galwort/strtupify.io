import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CompanyInstancePage } from './company-instance.page';

describe('CompanyInstancePage', () => {
  let component: CompanyInstancePage;
  let fixture: ComponentFixture<CompanyInstancePage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(CompanyInstancePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
