# Синтетическая «серия»: русская речь (espeak) по таймингам субтитров со сдвигом + музыка и шум.
import json, subprocess, random, numpy as np, wave, os
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".out"); os.makedirs(OUT, exist_ok=True); os.chdir(OUT)
random.seed(3); np.random.seed(3)
SR=16000
phrases=["Маомао, иди сюда быстрее","Господин Жэньши уже ждёт тебя во дворце","Это очень странное лекарство",
 "Гаошунь, ты слышал новости о саранче","Нет, я ничего не знаю","Император будет недоволен",
 "Подожди, мне нужно подумать","Почему ты так смотришь на меня","Это яд, без сомнений","Пойдём, времени мало"]
clips=[]
for i,p in enumerate(phrases):
    fn=f"p{i}.wav"
    subprocess.run(["espeak-ng","-v","ru","-s",str(random.choice([150,170,190])),"-w",fn,p],check=True)
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",fn,"-ar",str(SR),"-ac","1",f"r{i}.wav"],check=True)
    w=wave.open(f"r{i}.wav"); a=np.frombuffer(w.readframes(w.getnframes()),dtype=np.int16).astype(np.float32)/32768; clips.append(a)
# субтитры: реплики длиной = длине фразы, паузы случайные
subs=[]; t=4.0
while t<400:
    c=random.randrange(len(clips)); dur=len(clips[c])/SR
    subs.append([round(t,2),round(t+dur,2),c]); t+=dur+random.choice([0.4,0.8,1.5,2.5,4,7])
OFFSET=17.3  # заставка студии озвучки
total=int((420+OFFSET)*SR); audio=np.zeros(total,np.float32)
# «музыка»: аккорды, меняющиеся каждые 3 с + барабан
tt=np.arange(total)/SR
music=np.zeros(total,np.float32)
for k in range(0,int(tt[-1]//3)+1):
    a,b=int(k*3*SR),int(min((k+1)*3*SR,total)); f0=random.choice([110,131,147,165,196,220])
    seg=tt[a:b]; music[a:b]=sum(np.sin(2*np.pi*f0*m*seg)/m for m in (1,1.25,1.5,2))*0.05
kick=(np.sin(2*np.pi*55*tt)*np.exp(-((tt%0.5)*20)))*0.08
audio+=music+kick+np.random.randn(total).astype(np.float32)*0.004
# заставка студии: голос в первые секунды
intro=clips[0]; audio[int(2*SR):int(2*SR)+len(intro)]+=intro*0.8
for s,e,c in subs:
    st=int((s+OFFSET+random.uniform(0,0.25))*SR)  # озвучка чуть запаздывает
    cl=clips[c]*random.uniform(0.5,0.9); audio[st:st+len(cl)]+=cl[:max(0,total-st)]
audio=np.clip(audio,-1,1)
audio.astype(np.float32).tofile("episode.f32")
json.dump({"offset":OFFSET,"intervals":[[s,e] for s,e,_ in subs]},open("subs.json","w"))
print("subs",len(subs),"seconds",total/SR)

# видео для плеера и японские субтитры с именами
subprocess.run(["ffmpeg","-y","-loglevel","error","-f","f32le","-ar","16000","-ac","1","-i","episode.f32","-f","lavfi","-i","color=c=0x2a3550:s=640x360:r=10","-shortest","-c:v","libvpx","-b:v","40k","-c:a","libopus","-b:a","48k","episode.webm"],check=True)
def ts(x):
    h=int(x//3600); m=int(x%3600//60); s=x%60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s-int(s))*1000)):03d}"
lines=[]; mentions=[]
for i,(s,e,_) in enumerate(subs):
    if i%6==0: txt='猫猫、こっちに来て'; mentions.append((s,'maomao'))
    elif i%9==0: txt='（高順(ガオシュン)）壬氏様がお呼びです'; mentions.append((s,'jinshi'))
    elif i%10==0: txt='阿多様のところへ'; mentions.append((s,'ahduo'))
    else: txt='それは本当ですか'
    lines.append(f"{i+1}\n{ts(s)} --> {ts(e)}\n{txt}\n")
open('ep01.srt','w').write('\n'.join(lines)); json.dump(mentions,open('mentions.json','w'))
