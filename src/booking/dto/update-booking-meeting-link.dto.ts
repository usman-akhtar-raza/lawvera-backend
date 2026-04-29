import { IsString, IsUrl } from 'class-validator';

export class UpdateBookingMeetingLinkDto {
  @IsString()
  @IsUrl(
    {
      require_protocol: true,
    },
    {
      message: 'Meeting link must be a valid URL.',
    },
  )
  meetingLink: string;
}
